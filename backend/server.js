import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { google } from "googleapis";
import Groq from "groq-sdk";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const SYSTEM_PROMPT = `You are Aria, a friendly and efficient voice scheduling assistant. Your job is to help users book calendar meetings.

Follow this conversational flow:
1. Greet the user warmly and ask for their name.
2. Collect the date, time, and meeting title — can be in one message or multiple.
3. Once you have all three details, confirm them and ask the user to confirm.
4. When user confirms, emit the JSON block immediately.

<CALENDAR_EVENT>
{
  "title": "meeting title",
  "date": "YYYY-MM-DD",
  "time": "HH:MM",
  "duration": 60,
  "confirmed": true
}
</CALENDAR_EVENT>

RULES:
- NEVER mention checking the calendar — it happens automatically in the background.
- Keep responses to 1-2 sentences maximum.
- Today is ${new Date().toISOString().split("T")[0]}.
- Convert times: "8 PM" = "20:00", "9 AM" = "09:00", "3:30" = "15:30".`;

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI || "http://localhost:3001/auth/google/callback"
);

// ─── Persistent token store ───────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const TOKENS_FILE = join(__dirname, "tokens.json");

function loadTokens() {
  try {
    if (existsSync(TOKENS_FILE)) return JSON.parse(readFileSync(TOKENS_FILE, "utf8"));
  } catch (e) { console.error("Failed to load tokens:", e.message); }
  return {};
}

function saveTokens(store) {
  try { writeFileSync(TOKENS_FILE, JSON.stringify(store, null, 2)); }
  catch (e) { console.error("Failed to save tokens:", e.message); }
}

const tokenStore = loadTokens();
console.log(`Loaded ${Object.keys(tokenStore).length} persisted token(s)`);

const sessions = {};

function getSession(sessionId) {
  if (!sessions[sessionId]) {
    sessions[sessionId] = {
      history: [],
      calendarAuthed: false,
      pendingCheck: null,
      pendingEvent: null,
      conflictPending: false,
      bookAnyway: false,
    };
    // Restore by sessionId
    if (tokenStore[sessionId]) {
      sessions[sessionId].tokens = tokenStore[sessionId];
      sessions[sessionId].calendarAuthed = true;
    } else if (tokenStore["__primary__"]) {
      // Any new session gets the last signed-in user's tokens
      sessions[sessionId].tokens = tokenStore["__primary__"];
      sessions[sessionId].calendarAuthed = true;
      console.log(`Auto-restored tokens for new session ${sessionId.slice(0,8)}`);
    }
  }
  return sessions[sessionId];
}

function getCalendarClient(session) {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  auth.setCredentials(session.tokens);
  return google.calendar({ version: "v3", auth });
}

// ─── Fetch ALL events for a given date+time window ────────────────────────────
async function getEventsAtTime(session, date, time, duration = 60) {
  if (!session.calendarAuthed || !session.tokens) {
    console.log("[calendar] not authed, skipping check");
    return null;
  }
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
    console.log(`[calendar] found ${events.length} event(s) at ${date} ${time}`);
    return events.length > 0 ? events : null;
  } catch (err) {
    console.error("[calendar] error:", err.message);
    return null;
  }
}

// ─── Parse date and time from a user message ──────────────────────────────────
function parseDateTimeFromMessage(msg) {
  const lower = msg.toLowerCase();
  const today = new Date();
  let date = null;
  let time = null;

  // Parse time — handles "8pm", "8 pm", "8:30pm", "9 AM", "21:00"
  const timeMatch = lower.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i)
    || lower.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);

  if (timeMatch) {
    if (timeMatch[3]) {
      // 12h format with am/pm
      let h = parseInt(timeMatch[1]);
      const m = timeMatch[2] || "00";
      const ampm = timeMatch[3].toLowerCase();
      if (ampm === "pm" && h < 12) h += 12;
      if (ampm === "am" && h === 12) h = 0;
      time = `${String(h).padStart(2,"0")}:${m}`;
    } else {
      // 24h format
      time = `${String(timeMatch[1]).padStart(2,"0")}:${timeMatch[2]}`;
    }
  }

  // Parse date
  const days = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
  if (lower.includes("tomorrow")) {
    const d = new Date(today); d.setDate(d.getDate() + 1);
    date = d.toISOString().split("T")[0];
  } else if (lower.includes("today")) {
    date = today.toISOString().split("T")[0];
  } else {
    for (let i = 0; i < days.length; i++) {
      if (lower.includes(days[i])) {
        const d = new Date(today);
        let diff = i - d.getDay();
        if (diff <= 0) diff += 7;
        d.setDate(d.getDate() + diff);
        date = d.toISOString().split("T")[0];
        break;
      }
    }
  }

  return { date, time };
}

// ─── Format event details into a readable string ──────────────────────────────
function formatEventDetails(events) {
  return events.map(e => {
    const title = e.summary || "Untitled event";
    const start = e.start?.dateTime || e.start?.date;
    const timeStr = start
      ? new Date(start).toLocaleString("en-US", { weekday:"long", month:"long", day:"numeric", hour:"numeric", minute:"2-digit" })
      : "unknown time";
    return `"${title}" on ${timeStr}`;
  }).join(", and ");
}

// ─── Chat endpoint ────────────────────────────────────────────────────────────
app.post("/api/chat", async (req, res) => {
  const { sessionId, message } = req.body;
  if (!sessionId) return res.status(400).json({ error: "sessionId required" });

  const session     = getSession(sessionId);
  const userMessage = message || "[START]";

  try {
    // ── 1. Handle "book anyway" ───────────────────────────────────────────────
    const isBookAnyway = /book anyway|go ahead anyway|do it anyway|yes anyway|still book|doesn.t matter|overlap|just book/i.test(userMessage);
    if (isBookAnyway && session.conflictPending && session.pendingEvent) {
      const ev = session.pendingEvent;
      session.conflictPending = false;
      session.bookAnyway      = true;
      const dt  = new Date(`${ev.date}T${ev.time}`);
      const fmt = dt.toLocaleString("en-US", { weekday:"long", month:"long", day:"numeric", hour:"numeric", minute:"2-digit" });
      const msg = `Got it! Booking "${ev.title}" on ${fmt}. Here are the details:`;
      session.history = [...session.history, { role:"user", content: userMessage }, { role:"assistant", content: msg }];
      return res.json({ message: msg, calendarEvent: ev, hasConflict: false, sessionId });
    }

    // ── 2. Parse date+time from message ──────────────────────────────────────
    const { date: parsedDate, time: parsedTime } = parseDateTimeFromMessage(userMessage);

    // Update pendingCheck if we got new date or time
    if (parsedDate || parsedTime) {
      session.pendingCheck = {
        date:  parsedDate  || session.pendingCheck?.date,
        time:  parsedTime  || session.pendingCheck?.time,
        duration: 60,
      };
    }

    const { date: checkDate, time: checkTime } = session.pendingCheck || {};

    // ── 3. If we have date+time, check calendar BEFORE calling LLM ───────────
    if (checkDate && checkTime && !session.bookAnyway) {
      const events = await getEventsAtTime(session, checkDate, checkTime);

      if (events && events.length > 0) {
        // CONFLICT — skip LLM, return immediately with exact event details
        const details = formatEventDetails(events);
        const conflictMsg = `I checked your Google Calendar — you already have ${details} at that time. Would you like a different time, or book anyway?`;

        // Store pending event with current title if we have it
        if (!session.pendingEvent) {
          session.pendingEvent = { title: "meeting", date: checkDate, time: checkTime, duration: 60 };
        } else {
          session.pendingEvent.date = checkDate;
          session.pendingEvent.time = checkTime;
        }
        session.conflictPending = true;
        session.history = [...session.history, { role:"user", content: userMessage }, { role:"assistant", content: conflictMsg }];
        return res.json({ message: conflictMsg, calendarEvent: null, hasConflict: true, sessionId });
      }
    }

    // ── 4. Call Groq LLM ──────────────────────────────────────────────────────
    const calendarNote = (checkDate && checkTime && !session.bookAnyway)
      ? `\n\n[SYSTEM] Calendar checked for ${checkDate} at ${checkTime} — NO conflicts found. Proceed normally.`
      : "";

    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: SYSTEM_PROMPT + calendarNote },
        ...session.history,
        { role: "user", content: userMessage },
      ],
      max_tokens: 1024,
      temperature: 0.7,
    });

    let assistantMessage = completion.choices[0].message.content;

    // ── 5. Extract calendar event JSON from LLM response ──────────────────────
    const eventMatch = assistantMessage.match(/<CALENDAR_EVENT>([\s\S]*?)<\/CALENDAR_EVENT>/);
    let calendarEvent = null;

    if (eventMatch) {
      try {
        const parsed = JSON.parse(eventMatch[1].trim());

        // Safety net: check conflicts one more time
        const safetyEvents = session.calendarAuthed && !session.bookAnyway
          ? await getEventsAtTime(session, parsed.date, parsed.time, parsed.duration)
          : null;

        if (safetyEvents && safetyEvents.length > 0) {
          const details    = formatEventDetails(safetyEvents);
          const conflictMsg = `I checked your Google Calendar — you already have ${details} at that time. Would you like a different time, or book anyway?`;
          session.pendingEvent    = parsed;
          session.conflictPending = true;
          assistantMessage = conflictMsg;
        } else {
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

    session.history = [...session.history, { role:"user", content: userMessage }, { role:"assistant", content: assistantMessage }];
    const spokenResponse = assistantMessage.replace(/<CALENDAR_EVENT>[\s\S]*?<\/CALENDAR_EVENT>/g, "").trim();
    res.json({ message: spokenResponse, calendarEvent, hasConflict: session.conflictPending || false, sessionId });

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
    state: sessionId, prompt: "consent",
  });
  res.redirect(url);
});

app.get("/auth/google/callback", async (req, res) => {
  const { code, state: sessionId } = req.query;
  try {
    const { tokens } = await oauth2Client.getToken(code);
    const session = getSession(sessionId);
    session.calendarAuthed = true;
    session.tokens         = tokens;
    tokenStore[sessionId]    = tokens;
    tokenStore["__primary__"] = tokens;
    saveTokens(tokenStore);
    console.log(`Tokens saved for ${sessionId.slice(0,8)}`);
    res.redirect(`${process.env.FRONTEND_URL || "http://localhost:3000"}?authed=true&sessionId=${sessionId}`);
  } catch (err) {
    console.error("OAuth error:", err);
    res.redirect(`${process.env.FRONTEND_URL || "http://localhost:3000"}?error=auth_failed`);
  }
});

// ─── Create event ─────────────────────────────────────────────────────────────
app.post("/api/create-event", async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: "Invalid session" });
  const session = getSession(sessionId);
  if (!session.pendingEvent)                      return res.status(400).json({ error: "No pending event" });
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
    session.pendingEvent = null; session.conflictPending = false; session.bookAnyway = false;
    res.json({ success: true, eventId: event.data.id, eventLink: event.data.htmlLink, summary: event.data.summary, start: event.data.start.dateTime });
  } catch (err) {
    console.error("Calendar API error:", err);
    res.status(500).json({ error: "Failed to create calendar event", details: err.message });
  }
});

// ─── Demo mode ────────────────────────────────────────────────────────────────
app.post("/api/create-event-demo", (req, res) => {
  const { sessionId } = req.body;
  const session = getSession(sessionId);
  if (!session?.pendingEvent) return res.status(400).json({ error: "No pending event" });
  const { title, date, time } = session.pendingEvent;
  const start = new Date(`${date}T${time}:00`);
  session.pendingEvent = null;
  res.json({ success: true, demo: true, eventId: `demo_${Date.now()}`,
    eventLink: `https://calendar.google.com/calendar/r/eventedit?text=${encodeURIComponent(title)}&dates=${start.toISOString().replace(/[-:]/g,"").split(".")[0]}Z`,
    summary: title, start: start.toISOString() });
});

// ─── Health ───────────────────────────────────────────────────────────────────
app.get("/health", (req, res) =>
  res.json({ status:"ok", llm:"llama-3.3-70b via Groq", sessions: Object.keys(sessions).length, tokens: Object.keys(tokenStore).length })
);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Aria running on :${PORT} — Groq + Google Calendar`));