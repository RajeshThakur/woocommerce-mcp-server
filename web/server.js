// Web server for the Store Assistant demo: chat API + static UI + cost protection.
require("dotenv").config({ quiet: true });
const express = require("express");
const path = require("node:path");
const crypto = require("node:crypto");
const { createSession, chat, resolveApproval, MODEL } = require("./agent");
const { close, isReadOnly } = require("./mcp-client");

const PORT = process.env.PORT || 3000;
const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

const LIMITS = {
  perMinute: num(process.env.MAX_PER_MINUTE, 10), // requests per IP per minute
  perDayIp: num(process.env.MAX_PER_DAY_IP, 20), // requests per IP per day
  perDayGlobal: num(process.env.MAX_PER_DAY_GLOBAL, 200), // requests per day, everyone combined
  maxMessageChars: 500,
  maxSessions: 200,
  sessionTtlMs: 30 * 60 * 1000,
  maxSessionTokens: num(process.env.MAX_SESSION_TOKENS, 30000), // total tokens per conversation
};

const app = express();
app.set("trust proxy", 1); // Render sits behind one proxy; makes req.ip the real client IP
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  next();
});
app.use(express.json({ limit: "10kb" }));
app.use(express.static(path.join(__dirname, "public")));

// ---------- Rate limiting (in memory; a production version would use Redis) ----------
const minuteHits = new Map(); // ip -> [timestamps]
const dayHits = new Map(); // ip -> count today
let dayKey = utcDay();
let globalToday = 0;

function utcDay() {
  return new Date().toISOString().slice(0, 10);
}
function rollDay() {
  const k = utcDay();
  if (k !== dayKey) {
    dayKey = k;
    dayHits.clear();
    globalToday = 0;
  }
}

// Returns true if allowed (and counts the request). Call only for requests that can cost money.
function checkLimits(req, res) {
  rollDay();
  const ip = req.ip;
  const now = Date.now();
  const recent = (minuteHits.get(ip) || []).filter((t) => now - t < 60_000);
  if (recent.length >= LIMITS.perMinute) {
    res.status(429).json({ error: `Too many requests. Max ${LIMITS.perMinute} per minute. This is a demo, please slow down.` });
    return false;
  }
  if ((dayHits.get(ip) || 0) >= LIMITS.perDayIp) {
    res.status(429).json({ error: `Daily limit reached (${LIMITS.perDayIp} messages per day). Come back tomorrow, or run your own copy from GitHub.` });
    return false;
  }
  if (globalToday >= LIMITS.perDayGlobal) {
    res.status(429).json({ error: "The demo has reached its daily budget. Please try again tomorrow." });
    return false;
  }
  recent.push(now);
  minuteHits.set(ip, recent);
  dayHits.set(ip, (dayHits.get(ip) || 0) + 1);
  globalToday++;
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, ts] of minuteHits) {
    const recent = ts.filter((t) => now - t < 60_000);
    if (recent.length) minuteHits.set(ip, recent);
    else minuteHits.delete(ip);
  }
}, 60_000).unref();

// ---------- Sessions (server-side, so the browser can never forge history or approvals) ----------
const sessions = new Map();

function getSession(id) {
  const s = typeof id === "string" ? sessions.get(id) : null;
  if (!s) return null;
  if (Date.now() - s.lastUsed > LIMITS.sessionTtlMs) {
    sessions.delete(id);
    return null;
  }
  return s;
}

function newSession() {
  if (sessions.size >= LIMITS.maxSessions) {
    let oldestId = null;
    let oldest = Infinity;
    for (const [id, s] of sessions) {
      if (s.lastUsed < oldest) {
        oldest = s.lastUsed;
        oldestId = id;
      }
    }
    if (oldestId) sessions.delete(oldestId);
  }
  const id = crypto.randomUUID();
  const session = createSession();
  sessions.set(id, session);
  return { id, session };
}

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) if (now - s.lastUsed > LIMITS.sessionTtlMs) sessions.delete(id);
}, 5 * 60_000).unref();

// ---------- Error mapping: never leak internals to visitors ----------
function publicError(err) {
  if (err.status === 409) return { status: 409, message: err.message };
  if (err.status === 401 || err.code === "invalid_api_key") {
    return { status: 503, message: "The assistant is not configured correctly right now." };
  }
  if (err.status === 429 || err.code === "insufficient_quota") {
    return { status: 503, message: "The assistant is temporarily unavailable. Please try again later." };
  }
  return { status: 502, message: "Something went wrong while talking to the assistant. Please try again." };
}

async function withSession(req, res, sessionId, create, work) {
  let id = sessionId;
  let session = getSession(id);
  if (!session) {
    if (!create) {
      return res.status(404).json({ error: "This conversation has expired. Please start a new one.", resetSession: true });
    }
    ({ id, session } = newSession());
  }
  if (session.busy) return res.status(409).json({ error: "Still working on your last message." });

  const used = session.usage.prompt_tokens + session.usage.completion_tokens;
  if (used > LIMITS.maxSessionTokens) {
    sessions.delete(id);
    return res.status(429).json({ error: "This conversation has reached its length limit. Please start a new chat.", resetSession: true });
  }

  session.busy = true;
  try {
    const out = await work(session);
    return res.json({ sessionId: id, ...out });
  } catch (err) {
    console.error(`[chat error] ${err.status || ""} ${err.code || ""} ${err.message}`);
    const { status, message } = publicError(err);
    // History may be half-written after a real failure, so drop the session rather than risk a corrupt one.
    // A 409 is just a refusal (e.g. approval still pending) and leaves the session intact.
    if (status !== 409) sessions.delete(id);
    return res.status(status).json({ error: message, resetSession: status !== 409 });
  } finally {
    session.busy = false;
  }
}

// ---------- API ----------
app.post("/api/chat", async (req, res) => {
  const { sessionId, message } = req.body || {};
  if (typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "Type a message first." });
  }
  if (message.length > LIMITS.maxMessageChars) {
    return res.status(400).json({ error: `Messages are limited to ${LIMITS.maxMessageChars} characters.` });
  }
  if (!checkLimits(req, res)) return;
  return withSession(req, res, sessionId, true, (session) => chat(session, message.trim()));
});

app.post("/api/approve", async (req, res) => {
  const { sessionId, approve } = req.body || {};
  if (typeof sessionId !== "string" || typeof approve !== "boolean") {
    return res.status(400).json({ error: "sessionId and approve (true/false) are required." });
  }
  if (!checkLimits(req, res)) return;
  return withSession(req, res, sessionId, false, (session) => resolveApproval(session, approve));
});

app.get("/api/config", (_req, res) => {
  res.json({
    readOnly: isReadOnly(),
    model: MODEL,
    maxMessageChars: LIMITS.maxMessageChars,
    perDayIp: LIMITS.perDayIp,
  });
});

app.get("/api/usage", (_req, res) => {
  rollDay();
  res.json({ day: dayKey, used_today: globalToday, daily_limit: LIMITS.perDayGlobal, active_sessions: sessions.size });
});

app.get("/api/health", (_req, res) => res.json({ ok: true }));

const server = app.listen(PORT, () => {
  console.log(`Store Assistant running at http://localhost:${PORT}  (read-only: ${isReadOnly()}, model: ${MODEL})`);
  if (!process.env.OPENAI_API_KEY) console.warn("OPENAI_API_KEY is not set, chat calls will fail.");
});

async function shutdown() {
  server.close();
  await close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
