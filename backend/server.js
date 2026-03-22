import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { google } from "googleapis";
import Groq from "groq-sdk";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const SYSTEM_PROMPT = `You are Aria, a friendly and efficient voice scheduling assistant. Your job is to help users book calendar meetings.

Follow this conversational flow:
1. Greet the user warmly and ask for their name.
2. Ask for their preferred date (e.g., "tomorrow", "next Monday", "March 25th").
3. Ask for their preferred time (e.g., "2pm", "14:00", "morning").
4. Optionally ask for a meeting title/purpose (if they haven't mentioned it).
5. Before confirming, you will be given real-time calendar data. Use it.
6. Once user confirms AND no conflict (or user wants to book anyway), emit:

<CALENDAR_EVENT>
{
  "title": "meeting title",
  "date": "YYYY-MM-DD",
  "time": "HH:MM",
  "duration": 60,
  "description": "optional description",
  "confirmed": true
}
</CALENDAR_EVENT>

CONFLICT RULES (very important):
- If a [CALENDAR CHECK] note says there IS a conflict, do NOT emit the JSON block.
- Proactively tell the user: "I checked your calendar and you already have [event] at that time. Would you like a different time or book anyway?"
- Only emit the JSON block when there is NO conflict, OR the user explicitly says to book anyway.

Rules:
- Be conversational and natural, as if speaking aloud
- Keep responses concise (1-3 sentences when possible)
- Parse relative dates based on today: ${new Date().toISOString().split("T")[0]}
- Default meeting duration is 60 minutes unless specified`;

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI || "http://localhost:3001/auth/google/callback"
);

const sessions = {};

function getCalendarClient(session) {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  auth.setCredentials(session.tokens);
  return google.calendar({ version: "v3", auth });
}

// ─── Check conflicts for a given date+time ────────────────────────────────────
async function checkConflicts(session, date, time, duration = 60) {
  if (!session.calendarAuthed || !session.tokens) return null;
  try {
    const start    = new Date(`${date}T${time}:00`);
    const end      = new Date(start.getTime() + duration * 60000);
    const calendar = getCalendarClient(session);
    const res      = await calendar.events.list({
      calendarId:   "primary",
      timeMin:      start.toISOString(),
      timeMax:      end.toISOString(),
      singleEvents: true,
      orderBy:      "startTime",
    });
    const events = (res.data.items || []).filter(e => e.status !== "cancelled");
    return events.length > 0 ? events : null;
  } catch (err) {
    console.error("Conflict check error:", err.message);
    return null;
  }
}

// ─── Detect if the user message contains a date+time we can check ─────────────
// Looks at conversation history for a pendingCheck (date/time extracted by LLM)
async function maybeCheckConflictBeforeLLM(session, userMessage) {
  if (!session.calendarAuthed || !session.tokens) return null;

  // If there's already a pendingEvent date/time in session, check that slot
  // when user sends a confirmation-like message
  const isConfirming = /\byes\b|\bconfirm\b|\bgo ahead\b|\bcorrect\b|\bok\b|\bsure\b|\byep\b|\byeah\b/i.test(userMessage);

  if (isConfirming && session.pendingCheck) {
    const { date, time, duration } = session.pendingCheck;
    return await checkConflicts(session, date, time, duration);
  }
  return null;
}

// ─── Chat endpoint ────────────────────────────────────────────────────────────
app.post("/api/chat", async (req, res) => {
  const { sessionId, message } = req.body;
  if (!sessionId) return res.status(400).json({ error: "sessionId required" });

  if (!sessions[sessionId]) {
    sessions[sessionId] = { history: [], calendarAuthed: false };
  }

  const session     = sessions[sessionId];
  const userMessage = message || "[START]";

  try {
    // ── Step 1: Check conflict BEFORE calling LLM if user is confirming ───────
    const preCheckConflicts = await maybeCheckConflictBeforeLLM(session, userMessage);

    if (preCheckConflicts && preCheckConflicts.length > 0 && !session.bookAnyway) {
      // SKIP the LLM entirely — reply immediately with conflict warning
      const names = preCheckConflicts
        .map(e => {
          const t = e.start?.dateTime
            ? new Date(e.start.dateTime).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
            : "that time";
          return `"${e.summary || "Busy"}" at ${t}`;
        })
        .join(", ");

      const conflictMessage = `I checked your calendar and you already have ${names} at that time. Would you like to pick a different time, or book anyway?`;

      session.conflictPending = true;
      session.history = [
        ...session.history,
        { role: "user",      content: userMessage },
        { role: "assistant", content: conflictMessage },
      ];

      return res.json({
        message:     conflictMessage,
        calendarEvent: null,
        hasConflict: true,
        sessionId,
      });
    }

    // ── Step 2: Call LLM — inject "no conflict" note if we checked ───────────
    const conflictNote = session.pendingCheck && !preCheckConflicts
      ? "\n\n[CALENDAR CHECK] No conflicts found at the requested time. Proceed to confirm and emit the JSON block."
      : "";

    const systemWithConflict = SYSTEM_PROMPT + conflictNote;

    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: systemWithConflict },
        ...session.history,
        { role: "user", content: userMessage },
      ],
      max_tokens: 1024,
      temperature: 0.7,
    });

    let assistantMessage = completion.choices[0].message.content;

    // ── Step 3: Parse any calendar event the LLM emitted ─────────────────────
    const eventMatch = assistantMessage.match(/<CALENDAR_EVENT>([\s\S]*?)<\/CALENDAR_EVENT>/);
    let calendarEvent = null;

    if (eventMatch) {
      try {
        const parsed = JSON.parse(eventMatch[1].trim());

        // Double-check: run conflict check if we haven't already
        let finalConflicts = preCheckConflicts;
        if (!finalConflicts && session.calendarAuthed) {
          finalConflicts = await checkConflicts(session, parsed.date, parsed.time, parsed.duration);
        }

        if (finalConflicts && finalConflicts.length > 0 && !session.bookAnyway) {
          // LLM emitted JSON despite conflict — strip it and warn
          assistantMessage = assistantMessage
            .replace(/<CALENDAR_EVENT>[\s\S]*?<\/CALENDAR_EVENT>/g, "")
            .trim();
          const names = finalConflicts
            .map(e => `"${e.summary || "Busy"}"`)
            .join(", ");
          assistantMessage += ` (Note: I checked your calendar — you already have ${names} at that time. Would you like a different time, or book anyway?)`;
          session.pendingEvent    = parsed;
          session.conflictPending = true;
        } else {
          // All clear — accept the event
          calendarEvent           = parsed;
          session.pendingEvent    = parsed;
          session.conflictPending = false;
          session.bookAnyway      = false;
          session.pendingCheck    = null;
        }
      } catch (e) {
        console.error("Failed to parse calendar event:", e);
      }
    }

    // ── Step 4: Store date/time from LLM response for next-turn conflict check ─
    // When LLM asks "shall I book X on DATE at TIME?", store that for pre-check
    const dateTimeMatch = assistantMessage.match(/(\d{4}-\d{2}-\d{2}).*?(\d{2}:\d{2})/);
    if (dateTimeMatch && !calendarEvent) {
      session.pendingCheck = {
        date:     dateTimeMatch[1],
        time:     dateTimeMatch[2],
        duration: 60,
      };
    }

    // ── Step 5: Handle "book anyway" ─────────────────────────────────────────
    if (!calendarEvent && session.conflictPending && session.pendingEvent) {
      const bookAnyway = /book anyway|go ahead|doesn.t matter|do it anyway|yes anyway|doesn.t bother|still book|book it/i.test(userMessage);
      if (bookAnyway) {
        calendarEvent           = session.pendingEvent;
        session.conflictPending = false;
        session.bookAnyway      = true;
        session.pendingCheck    = null;
        // Rewrite response to confirm
        assistantMessage = `Got it! I'll book "${calendarEvent.title}" on ${new Date(`${calendarEvent.date}T${calendarEvent.time}`).toLocaleString("en-US", { weekday:"long", month:"long", day:"numeric", hour:"numeric", minute:"2-digit" })} even with the existing event. Here are the details:`;
      }
    }

    // ── Step 6: Save history ──────────────────────────────────────────────────
    session.history = [
      ...session.history,
      { role: "user",      content: userMessage },
      { role: "assistant", content: assistantMessage },
    ];

    const spokenResponse = assistantMessage
      .replace(/<CALENDAR_EVENT>[\s\S]*?<\/CALENDAR_EVENT>/g, "")
      .trim();

    res.json({
      message:       spokenResponse,
      calendarEvent,
      hasConflict:   session.conflictPending || false,
      sessionId,
    });

  } catch (err) {
    console.error("Groq error:", err);
    res.status(500).json({ error: "AI service error", details: err.message });
  }
});

// ─── Google OAuth ─────────────────────────────────────────────────────────────
app.get("/auth/google", (req, res) => {
  const { sessionId } = req.query;
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: [
      "https://www.googleapis.com/auth/calendar.events",
      "https://www.googleapis.com/auth/calendar.readonly",
    ],
    state:  sessionId,
    prompt: "consent",
  });
  res.redirect(url);
});

app.get("/auth/google/callback", async (req, res) => {
  const { code, state: sessionId } = req.query;
  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    if (sessions[sessionId]) {
      sessions[sessionId].calendarAuthed = true;
      sessions[sessionId].tokens         = tokens;
    }
    res.redirect(
      `${process.env.FRONTEND_URL || "http://localhost:3000"}?authed=true&sessionId=${sessionId}`
    );
  } catch (err) {
    console.error("OAuth error:", err);
    res.redirect(`${process.env.FRONTEND_URL || "http://localhost:3000"}?error=auth_failed`);
  }
});

// ─── Create event ─────────────────────────────────────────────────────────────
app.post("/api/create-event", async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId || !sessions[sessionId]) return res.status(400).json({ error: "Invalid session" });

  const session = sessions[sessionId];
  if (!session.pendingEvent)                 return res.status(400).json({ error: "No pending event" });
  if (!session.calendarAuthed || !session.tokens) return res.status(401).json({ error: "Calendar not authorized" });

  const { title, date, time, duration, description } = session.pendingEvent;
  const startDateTime = new Date(`${date}T${time}:00`);
  const endDateTime   = new Date(startDateTime.getTime() + (duration || 60) * 60000);
  const calendar      = getCalendarClient(session);

  try {
    const event = await calendar.events.insert({
      calendarId: "primary",
      requestBody: {
        summary:     title,
        description: description || "Scheduled via Aria Voice Scheduling Agent",
        start:       { dateTime: startDateTime.toISOString() },
        end:         { dateTime: endDateTime.toISOString() },
      },
    });
    session.pendingEvent    = null;
    session.conflictPending = false;
    session.bookAnyway      = false;
    res.json({
      success:   true,
      eventId:   event.data.id,
      eventLink: event.data.htmlLink,
      summary:   event.data.summary,
      start:     event.data.start.dateTime,
    });
  } catch (err) {
    console.error("Calendar API error:", err);
    res.status(500).json({ error: "Failed to create calendar event", details: err.message });
  }
});

// ─── Demo mode ────────────────────────────────────────────────────────────────
app.post("/api/create-event-demo", (req, res) => {
  const { sessionId } = req.body;
  if (!sessions[sessionId]?.pendingEvent) return res.status(400).json({ error: "No pending event in session" });

  const { title, date, time } = sessions[sessionId].pendingEvent;
  const startDateTime         = new Date(`${date}T${time}:00`);
  sessions[sessionId].pendingEvent    = null;
  sessions[sessionId].conflictPending = false;

  res.json({
    success:   true,
    demo:      true,
    eventId:   `demo_${Date.now()}`,
    eventLink: `https://calendar.google.com/calendar/r/eventedit?text=${encodeURIComponent(title)}&dates=${startDateTime.toISOString().replace(/[-:]/g, "").split(".")[0]}Z`,
    summary:   title,
    start:     startDateTime.toISOString(),
  });
});

// ─── Health ───────────────────────────────────────────────────────────────────
app.get("/health", (req, res) =>
  res.json({ status: "ok", llm: "llama-3.3-70b via Groq (free)", sessions: Object.keys(sessions).length })
);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Aria running on :${PORT} — powered by Groq / Llama 3.3 (free tier)`));