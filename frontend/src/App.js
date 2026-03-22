import React, { useState, useEffect, useRef, useCallback } from "react";
import { v4 as uuidv4 } from "uuid";
import "./App.css";

const API_BASE = process.env.REACT_APP_API_URL || "";
const DEEPGRAM_API_KEY = process.env.REACT_APP_DEEPGRAM_API_KEY || "";

// ─── TTS: browser speech synthesis ───────────────────────────────────────────
const speak = (text, onEnd) => {
  if (!window.speechSynthesis) return onEnd?.();
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.rate = 0.95; utter.pitch = 1.05; utter.volume = 1;
  const voices = window.speechSynthesis.getVoices();
  const preferred = voices.find(v =>
    v.name.includes("Samantha") || v.name.includes("Karen") ||
    v.name.includes("Google US English") || v.lang === "en-US"
  );
  if (preferred) utter.voice = preferred;
  utter.onend = onEnd;
  window.speechSynthesis.speak(utter);
};

// ─── Waveform ─────────────────────────────────────────────────────────────────
function WaveformBars({ active, speaking }) {
  return (
    <div className={`waveform ${active ? "active" : ""} ${speaking ? "speaking" : ""}`}>
      {[...Array(12)].map((_, i) => (
        <div key={i} className="bar" style={{ animationDelay: `${i * 0.08}s` }} />
      ))}
    </div>
  );
}

// ─── Live transcript pill ─────────────────────────────────────────────────────
function LiveTranscript({ text }) {
  if (!text) return null;
  return (
    <div className="live-transcript">
      <span className="live-dot" />
      {text}
    </div>
  );
}

// ─── Message bubble ───────────────────────────────────────────────────────────
function Message({ msg }) {
  return (
    <div className={`message ${msg.role}`}>
      {msg.role === "assistant" && <div className="avatar">A</div>}
      <div className="bubble">{msg.content}</div>
    </div>
  );
}

// ─── Calendar Event Card ──────────────────────────────────────────────────────
function EventCard({ event, onConfirm, onCancel, creating, created, eventLink }) {
  if (!event) return null;
  const dateObj = new Date(`${event.date}T${event.time}:00`);
  const formatted = dateObj.toLocaleString("en-US", {
    weekday: "long", month: "long", day: "numeric",
    hour: "numeric", minute: "2-digit",
  });
  return (
    <div className={`event-card ${created ? "created" : ""}`}>
      <div className="event-header">
        <span className="event-icon">{created ? "✅" : "📅"}</span>
        <span className="event-label">{created ? "Event Created!" : "Confirm Event"}</span>
      </div>
      <div className="event-title">{event.title}</div>
      <div className="event-time">{formatted}</div>
      <div className="event-duration">{event.duration || 60} minutes</div>
      {!created && (
        <div className="event-actions">
          <button className="btn-confirm" onClick={onConfirm} disabled={creating}>
            {creating ? "Creating…" : "Add to Google Calendar"}
          </button>
          <button className="btn-cancel" onClick={onCancel} disabled={creating}>Edit</button>
        </div>
      )}
      {created && eventLink && (
        <a className="event-link" href={eventLink} target="_blank" rel="noreferrer">
          View in Google Calendar →
        </a>
      )}
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [sessionId] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("sessionId") || uuidv4();
  });

  const [messages, setMessages]           = useState([]);
  const [input, setInput]                 = useState("");
  const [listening, setListening]         = useState(false);
  const [speaking, setSpeaking]           = useState(false);
  const [loading, setLoading]             = useState(false);
  const [started, setStarted]             = useState(false);
  const [mode, setMode]                   = useState("text");
  const [liveTranscript, setLiveTranscript] = useState("");
  const [pendingEvent, setPendingEvent]   = useState(null);
  const [creatingEvent, setCreatingEvent] = useState(false);
  const [createdEvent, setCreatedEvent]   = useState(null);
  const [calendarAuthed, setCalendarAuthed] = useState(false);

  // Deepgram STT refs
  const socketRef    = useRef(null);
  const mediaRecRef  = useRef(null);
  const streamRef    = useRef(null);
  const finalRef     = useRef("");

  const messagesEndRef = useRef(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("authed") === "true") {
      setCalendarAuthed(true);
      window.history.replaceState({}, "", window.location.pathname);
    }
    window.speechSynthesis?.getVoices();
  }, []);

  const addMessage = useCallback((role, content) => {
    setMessages(prev => [...prev, { role, content, id: uuidv4() }]);
  }, []);

  // ─── Send to Gemini backend ───────────────────────────────────────────────
  const sendMessage = useCallback(async (text) => {
    if (!text.trim() || loading) return;
    addMessage("user", text);
    setInput("");
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, message: text }),
      });
      const data = await res.json();
      addMessage("assistant", data.message);
      if (data.calendarEvent) setPendingEvent(data.calendarEvent);
      if (mode === "voice") {
        setSpeaking(true);
        speak(data.message, () => setSpeaking(false));
      }
    } catch {
      addMessage("assistant", "Sorry, I ran into an error. Please try again.");
    } finally {
      setLoading(false);
    }
  }, [sessionId, loading, addMessage, mode]);

  // ─── Stop mic + Deepgram socket ───────────────────────────────────────────
  const stopListening = useCallback(() => {
    if (mediaRecRef.current?.state !== "inactive") mediaRecRef.current?.stop();
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    setListening(false);
  }, []);

  // ─── Start Deepgram STT ───────────────────────────────────────────────────
  const startListening = useCallback(async () => {
    if (!DEEPGRAM_API_KEY) {
      alert("Add REACT_APP_DEEPGRAM_API_KEY to frontend/.env");
      return;
    }
    if (listening || speaking || loading) return;

    setLiveTranscript("");
    finalRef.current = "";

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      // Use whatever encoding the browser supports
      const mimeType =
        MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" :
        MediaRecorder.isTypeSupported("audio/webm")             ? "audio/webm" :
        MediaRecorder.isTypeSupported("audio/ogg;codecs=opus")  ? "audio/ogg;codecs=opus" : "";

      // const encoding =
      //   mimeType.includes("ogg") ? "ogg-opus" :
      //   mimeType.includes("webm") ? "webm" : "linear16";

      // // Build Deepgram URL — key in query param (most reliable auth method)
      // const url =
      //   `wss://api.deepgram.com/v1/listen` +
      //   `?model=nova-2` +
      //   `&language=en-US` +
      //   `&smart_format=true` +
      //   `&interim_results=true` +
      //   `&utterance_end_ms=1200` +
      //   `&endpointing=400` +
      //   (encoding !== "linear16" ? `&encoding=${encoding}` : `&encoding=linear16&sample_rate=16000`) +
      //   `&channels=1` +
      //   `&token=${DEEPGRAM_API_KEY}`;

      const url =
      `wss://api.deepgram.com/v1/listen` +
      `?model=nova-2` +
      `&language=en-US` +
      `&smart_format=true` +
      `&interim_results=true` +
      `&utterance_end_ms=1200` +
      `&endpointing=400` +
      `&channels=1`;

      // const ws = new WebSocket(url);
      const ws = new WebSocket(url, ["token", DEEPGRAM_API_KEY]);
      socketRef.current = ws;

      ws.onopen = () => {
        setListening(true);
        // Use default MediaRecorder format (no mimeType override — most compatible)
        // const rec = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
        const rec = new MediaRecorder(stream);
        mediaRecRef.current = rec;

        rec.ondataavailable = e => {
          if (e.data.size > 0 && ws.readyState === WebSocket.OPEN) ws.send(e.data);
        };
        rec.onstop = () => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "CloseStream" }));
        };
        rec.start(150);
      };

      ws.onmessage = evt => {
        try {
          const msg = JSON.parse(evt.data);

          // UtteranceEnd → submit whatever we have
          if (msg.type === "UtteranceEnd") {
            const final = finalRef.current.trim();
            setLiveTranscript("");
            finalRef.current = "";
            if (final) { sendMessage(final); stopListening(); }
            return;
          }

          if (msg.type !== "Results") return;
          const transcript = msg.channel?.alternatives?.[0]?.transcript;
          if (!transcript) return;

          if (msg.is_final) {
            finalRef.current += (finalRef.current ? " " : "") + transcript;
            setLiveTranscript(finalRef.current);
          } else {
            // Show interim words live as user speaks
            setLiveTranscript(
              finalRef.current + (finalRef.current ? " " : "") + transcript
            );
          }
        } catch { /* non-JSON frame */ }
      };

      ws.onerror = err => { console.error("Deepgram error:", err); stopListening(); };
      ws.onclose = () => {
        setListening(false);
        const final = finalRef.current.trim();
        if (final) { setLiveTranscript(""); finalRef.current = ""; sendMessage(final); }
      };

    } catch (err) {
      console.error("Mic error:", err);
      alert("Microphone access denied. Please allow mic permissions in Chrome.");
      setListening(false);
    }
  }, [listening, speaking, loading, sendMessage, stopListening]);

  const startConversation = useCallback(async () => {
    setStarted(true);
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, message: "[START]" }),
      });
      const data = await res.json();
      addMessage("assistant", data.message);
      if (mode === "voice") { setSpeaking(true); speak(data.message, () => setSpeaking(false)); }
    } catch {
      addMessage("assistant", "Hello! I'm Aria, your scheduling assistant. What's your name?");
    } finally {
      setLoading(false);
    }
  }, [sessionId, addMessage, mode]);

  // ─── Calendar ─────────────────────────────────────────────────────────────
  const handleCreateEvent = useCallback(async () => {
    const isDemoMode = process.env.REACT_APP_DEMO_MODE === "true";
    if (!calendarAuthed && !isDemoMode) {
      window.location.href = `${API_BASE}/auth/google?sessionId=${sessionId}`;
      return;
    }
    setCreatingEvent(true);
    const endpoint = isDemoMode ? "/api/create-event-demo" : "/api/create-event";
    try {
      const res = await fetch(`${API_BASE}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      const data = await res.json();
      if (data.success) {
        setCreatedEvent({ link: data.eventLink, summary: data.summary });
        setPendingEvent(null);
        addMessage("assistant", `Done! "${data.summary}" has been added to your Google Calendar.`);
      } else {
        addMessage("assistant", "Couldn't create the event. " + (data.error || "Please try again."));
      }
    } catch {
      addMessage("assistant", "Failed to create the event. Please try again.");
    } finally {
      setCreatingEvent(false);
    }
  }, [calendarAuthed, sessionId, addMessage]);

  const handleCancelEvent = useCallback(() => {
    setPendingEvent(null);
    sendMessage("Let me change the details.");
  }, [sendMessage]);

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="app">
      <div className="bg-orbs">
        <div className="orb orb-1" /><div className="orb orb-2" /><div className="orb orb-3" />
      </div>

      <header className="header">
        <div className="logo">
          <span className="logo-icon">◈</span>
          <span className="logo-text">aria</span>
        </div>
        <div className="mode-toggle">
          <button className={`mode-btn ${mode === "text" ? "active" : ""}`} onClick={() => setMode("text")}>Text</button>
          <button className={`mode-btn ${mode === "voice" ? "active" : ""}`} onClick={() => setMode("voice")}>Voice</button>
        </div>
      </header>

      <main className="main">
        {!started ? (
          <div className="landing">
            <WaveformBars active={false} speaking={false} />
            <h1 className="landing-title">Meet <em>Aria</em></h1>
            <p className="landing-sub">
              Your AI voice assistant for effortless scheduling.<br />
              Just talk — Aria handles the rest.
            </p>
            <div className="landing-features">
              <span>🎙 Deepgram STT</span>
              <span>📅 Google Calendar</span>
              <span>⚡ Instant booking</span>
            </div>
            <button className="btn-start" onClick={startConversation}>
              Start Scheduling
            </button>
          </div>
        ) : (
          <>
            <div className="chat-area">
              <div className="messages">
                {messages.map(msg => <Message key={msg.id} msg={msg} />)}
                {loading && (
                  <div className="message assistant">
                    <div className="avatar">A</div>
                    <div className="bubble typing"><span /><span /><span /></div>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>

              {pendingEvent && (
                <EventCard event={pendingEvent} onConfirm={handleCreateEvent}
                  onCancel={handleCancelEvent} creating={creatingEvent} created={false} />
              )}
              {createdEvent && (
                <EventCard event={{ title: createdEvent.summary }}
                  created={true} eventLink={createdEvent.link} />
              )}
            </div>

            <div className="input-area">
              {mode === "voice" && (
                <div className="voice-status">
                  <WaveformBars active={listening} speaking={speaking} />
                  <span className="voice-label">
                    {listening ? "Listening…" : speaking ? "Speaking…" : "Ready"}
                  </span>
                </div>
              )}
              {mode === "voice" && <LiveTranscript text={liveTranscript} />}
              <div className="input-row">
                <input className="text-input" value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && sendMessage(input)}
                  placeholder="Type your message…"
                  disabled={loading || listening} />
                <button className="btn-send" onClick={() => sendMessage(input)}
                  disabled={!input.trim() || loading}>↑</button>
                {mode === "voice" && (
                  <button
                    className={`btn-mic ${listening ? "recording" : ""}`}
                    onClick={listening ? stopListening : startListening}
                    disabled={loading || speaking}
                    title={listening ? "Click to send" : "Click to speak"}
                  >
                    {listening ? "⬛" : "🎙"}
                  </button>
                )}
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
