import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { google } from "googleapis";
import Groq from "groq-sdk";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// ─── Groq client (FREE: ~14,400 req/day, no credit card needed) ──────────────
// Get key at: https://console.groq.com → API Keys → Create API Key
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const SYSTEM_PROMPT = `You are Aria, a friendly and efficient voice scheduling assistant. Your job is to help users book calendar meetings.

Follow this conversational flow:
1. Greet the user warmly and ask for their name.
2. Ask for their preferred date (e.g., "tomorrow", "next Monday", "March 25th").
3. Ask for their preferred time (e.g., "2pm", "14:00", "morning").
4. Optionally ask for a meeting title/purpose (if they haven't mentioned it).
5. Confirm ALL details clearly before creating the event.
6. Once confirmed, respond with a JSON block in this exact format (alongside your spoken confirmation):

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

Rules:
- Be conversational and natural, as if speaking aloud
- Keep responses concise (1-3 sentences when possible)
- Always confirm details before creating the event
- Parse relative dates like "tomorrow", "next Monday" based on today's date: ${new Date().toISOString().split("T")[0]}
- For ambiguous times, ask for clarification
- Default meeting duration is 60 minutes unless specified
- Only include the JSON block when the user has explicitly confirmed`;

// ─── Google Calendar OAuth2 ───────────────────────────────────────────────────
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI || "http://localhost:3001/auth/google/callback"
);

// ─── In-memory session store ──────────────────────────────────────────────────
const sessions = {};

// ─── Chat endpoint ────────────────────────────────────────────────────────────
app.post("/api/chat", async (req, res) => {
  const { sessionId, message } = req.body;

  if (!sessionId) return res.status(400).json({ error: "sessionId required" });

  if (!sessions[sessionId]) {
    sessions[sessionId] = { history: [], calendarAuthed: false };
  }

  const session = sessions[sessionId];
  const userMessage = message || "[START]";

  try {
    // Groq uses OpenAI-compatible format: system + history + new user message
    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        ...session.history,                          // previous turns as-is
        { role: "user", content: userMessage },      // new user message
      ],
      max_tokens: 1024,
      temperature: 0.7,
    });

    const assistantMessage = completion.choices[0].message.content;

    // Append both turns to session history
    session.history = [
      ...session.history,
      { role: "user", content: userMessage },
      { role: "assistant", content: assistantMessage },
    ];

    // Extract <CALENDAR_EVENT> JSON if present
    let calendarEvent = null;
    const eventMatch = assistantMessage.match(/<CALENDAR_EVENT>([\s\S]*?)<\/CALENDAR_EVENT>/);
    if (eventMatch) {
      try {
        calendarEvent = JSON.parse(eventMatch[1].trim());
        session.pendingEvent = calendarEvent;
      } catch (e) {
        console.error("Failed to parse calendar event:", e);
      }
    }

    // Strip the JSON block from the spoken response
    const spokenResponse = assistantMessage
      .replace(/<CALENDAR_EVENT>[\s\S]*?<\/CALENDAR_EVENT>/g, "")
      .trim();

    res.json({
      message: spokenResponse,
      calendarEvent,
      needsCalendarAuth: calendarEvent && !session.calendarAuthed,
      sessionId,
    });
  } catch (err) {
    console.error("Groq error:", err);
    res.status(500).json({ error: "AI service error", details: err.message });
  }
});

// ─── Google OAuth flow ────────────────────────────────────────────────────────
app.get("/auth/google", (req, res) => {
  const { sessionId } = req.query;
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: ["https://www.googleapis.com/auth/calendar.events"],
    state: sessionId,
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
      sessions[sessionId].tokens = tokens;
    }
    res.redirect(
      `${process.env.FRONTEND_URL || "http://localhost:3000"}?authed=true&sessionId=${sessionId}`
    );
  } catch (err) {
    console.error("OAuth error:", err);
    res.redirect(
      `${process.env.FRONTEND_URL || "http://localhost:3000"}?error=auth_failed`
    );
  }
});

// ─── Create real Google Calendar event ───────────────────────────────────────
app.post("/api/create-event", async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId || !sessions[sessionId]) return res.status(400).json({ error: "Invalid session" });

  const session = sessions[sessionId];
  if (!session.pendingEvent) return res.status(400).json({ error: "No pending event" });
  if (!session.calendarAuthed || !session.tokens) return res.status(401).json({ error: "Calendar not authorized" });

  const { title, date, time, duration, description } = session.pendingEvent;
  const startDateTime = new Date(`${date}T${time}:00`);
  const endDateTime = new Date(startDateTime.getTime() + (duration || 60) * 60000);

  const auth = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
  auth.setCredentials(session.tokens);
  const calendar = google.calendar({ version: "v3", auth });

  try {
    const event = await calendar.events.insert({
      calendarId: "primary",
      requestBody: {
        summary: title,
        description: description || "Scheduled via Aria Voice Scheduling Agent",
        start: { dateTime: startDateTime.toISOString() },
        end: { dateTime: endDateTime.toISOString() },
      },
    });
    session.pendingEvent = null;
    res.json({
      success: true,
      eventId: event.data.id,
      eventLink: event.data.htmlLink,
      summary: event.data.summary,
      start: event.data.start.dateTime,
    });
  } catch (err) {
    console.error("Calendar API error:", err);
    res.status(500).json({ error: "Failed to create calendar event", details: err.message });
  }
});

// ─── Demo mode: mock event (no Google auth needed) ────────────────────────────
app.post("/api/create-event-demo", (req, res) => {
  const { sessionId } = req.body;
  if (!sessions[sessionId]?.pendingEvent) return res.status(400).json({ error: "No pending event in session" });

  const { title, date, time } = sessions[sessionId].pendingEvent;
  const startDateTime = new Date(`${date}T${time}:00`);
  sessions[sessionId].pendingEvent = null;

  res.json({
    success: true,
    demo: true,
    eventId: `demo_${Date.now()}`,
    eventLink: `https://calendar.google.com/calendar/r/eventedit?text=${encodeURIComponent(title)}&dates=${startDateTime.toISOString().replace(/[-:]/g, "").split(".")[0]}Z`,
    summary: title,
    start: startDateTime.toISOString(),
  });
});

// ─── Debug: session state ─────────────────────────────────────────────────────
app.get("/api/session/:sessionId", (req, res) => {
  const session = sessions[req.params.sessionId];
  if (!session) return res.status(404).json({ error: "Session not found" });
  res.json({
    historyLength: session.history?.length ?? 0,
    calendarAuthed: session.calendarAuthed ?? false,
    hasPendingEvent: !!session.pendingEvent,
    pendingEvent: session.pendingEvent ?? null,
  });
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (req, res) =>
  res.json({ status: "ok", llm: "llama-3.3-70b via Groq (free)", sessions: Object.keys(sessions).length })
);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Aria running on :${PORT} — powered by Groq / Llama 3.3 (free tier)`));
