/**
 * mcia_service.js — MCIA proxy module for Render (FINAL COMPLETE)
 * SAFE: aucune régression, uniquement extensions
 */

const PYTHONANYWHERE_BASE = process.env.PYTHONANYWHERE_BASE_URL;
const NVIDIA_API_URL      = process.env.NVIDIA_API_URL;
const GEMINI_API_URL      = process.env.GEMINI_API_URL;

if (!PYTHONANYWHERE_BASE) throw new Error("PYTHONANYWHERE_BASE_URL manquant");

const TIMEOUT_CHAT  = 75000;
const TIMEOUT_PING  = 10000;
const TIMEOUT_LLM   = 60000;

const cache = new Map();
const CACHE_TTL = 1000 * 60 * 2;

// ─── Helpers ─────────────────────────────────

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", chunk => body += chunk.toString());
    req.on("end", () => {
      try { resolve(JSON.parse(body || "{}")); }
      catch { resolve({}); }
    });
  });
}

function send(res, data, code = 200) {
  if (!res.headersSent) {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  }
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("timeout " + ms)), ms)
    )
  ]);
}

// ─── LLM (INCHANGÉ) ──────────────────────────

async function callNvidiaKimi(messages) {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) throw new Error("no kimi key");

  const res = await withTimeout(fetch(NVIDIA_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: "moonshotai/kimi-k2.6", messages }),
  }), TIMEOUT_LLM);

  const data = await res.json();
  return data?.choices?.[0]?.message?.content || "";
}

async function callGemini(messages) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("no gemini key");

  const res = await withTimeout(fetch(GEMINI_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-goog-api-key": apiKey,
    },
    body: JSON.stringify({ contents: messages }),
  }), TIMEOUT_LLM);

  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

// ─── CORE PROXY ──────────────────────────────

async function forward(path, options = {}, timeout = TIMEOUT_CHAT) {
  const res = await withTimeout(fetch(PYTHONANYWHERE_BASE + path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  }), timeout);

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(txt);
  }

  return res.json();
}

// ─── ROUTES EXISTANTES (INCHANGÉES) ──────────

async function handleChat(req, res) {
  const body = await readBody(req);

  try {
    const data = await forward("/mcia/chat", {
      method: "POST",
      body: JSON.stringify(body),
    });

    return send(res, data);

  } catch (e) {
    console.warn("fallback LLM");

    const messages = [
      { role: "system", content: "MCIA chorale assistant" },
      ...(body.history || []),
      { role: "user", content: body.message },
    ];

    try {
      const text = await callNvidiaKimi(messages);
      return send(res, { response: text, model_used: "kimi" });
    } catch {
      const text = await callGemini(messages);
      return send(res, { response: text, model_used: "gemini" });
    }
  }
}

async function handlePing(res) {
  const c = cache.get("ping");
  if (c && Date.now() - c.t < CACHE_TTL) return send(res, c.d);

  try {
    const d = await forward("/mcia/chat/ping", {}, TIMEOUT_PING);
    cache.set("ping", { d, t: Date.now() });
    return send(res, d);
  } catch (e) {
    return send(res, { error: e.message }, 502);
  }
}

// ─── 🔥 NOUVELLES ROUTES CONTEXTE ─────────────

// hymns
async function hymns(res, query = "") {
  return send(res, await forward("/mcia/hymns" + query));
}

// gloria
async function gloria(res) {
  return send(res, await forward("/mcia/gloria"));
}

// jic
async function jic(res) {
  return send(res, await forward("/mcia/jic"));
}

// programme
async function programme(res, sub = "") {
  return send(res, await forward("/mcia/programme" + sub));
}

// psaumes / prieres / ressources
async function simple(res, path) {
  return send(res, await forward(path));
}

// ─── 🧠 PASSTHROUGH GÉNÉRIQUE (TRÈS IMPORTANT) ─────────

async function passthrough(req, res, pathname) {
  try {
    const body = req.method === "POST" ? await readBody(req) : null;

    const data = await forward(pathname.replace("/mcia", ""), {
      method: req.method,
      body: body ? JSON.stringify(body) : undefined,
    });

    return send(res, data);

  } catch (e) {
    return send(res, { error: e.message }, 502);
  }
}

// ─── ROUTER FINAL ─────────────────────────────

async function handleMciaRoutes(req, res, pathname) {
  try {

    // CORE
    if (pathname === "/mcia/chat" && req.method === "POST")
      return handleChat(req, res);

    if (pathname === "/mcia/chat/ping")
      return handlePing(res);

    // CONTEXTE
    if (pathname.startsWith("/mcia/hymns"))
      return hymns(res, pathname.replace("/mcia/hymns", ""));

    if (pathname === "/mcia/gloria")
      return gloria(res);

    if (pathname === "/mcia/jic")
      return jic(res);

    if (pathname.startsWith("/mcia/programme"))
      return programme(res, pathname.replace("/mcia/programme", ""));

    if (pathname === "/mcia/psaumes")
      return simple(res, "/mcia/psaumes");

    if (pathname === "/mcia/prieres")
      return simple(res, "/mcia/prieres");

    if (pathname === "/mcia/ressources")
      return simple(res, "/mcia/ressources");

    // 🔥 fallback total (NE RATE AUCUNE ROUTE)
    if (pathname.startsWith("/mcia"))
      return passthrough(req, res, pathname);

    return send(res, { error: "not found" }, 404);

  } catch (err) {
    console.error("MCIA crash:", err);
    return send(res, { error: err.message }, 500);
  }
}

module.exports = { handleMciaRoutes };