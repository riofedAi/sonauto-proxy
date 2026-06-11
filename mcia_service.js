/**
 * mcia_service.js — MCIA + Data proxy module for Render
 * Forwards all routes to PythonAnywhere + direct LLM fallback for /mcia/chat
 *
 * Routes exposées :
 *
 * ── MCIA Chat ──────────────────────────────────────────────────────
 *   POST /mcia/chat
 *   GET  /mcia/chat/ping
 *   GET  /mcia/models
 *
 * ── MCIA Contexte ──────────────────────────────────────────────────
 *   GET  /mcia/cultes
 *   GET  /mcia/cultes/:id
 *   GET  /mcia/cultes/:id/etapes
 *   GET  /mcia/cultes/search
 *   GET  /mcia/cultes-speciaux-v2
 *   GET  /mcia/guide/:culte_id
 *   GET  /mcia/psaumes
 *   GET  /mcia/psaumes/:pid
 *   GET  /mcia/prieres
 *   GET  /mcia/prieres/:pid
 *   GET  /mcia/cantiques-rituel
 *   GET  /mcia/protocole
 *   GET  /mcia/ressources
 *   GET  /mcia/knowledge-base
 *   GET  /mcia/knowledge/search
 *   GET  /mcia/stats
 *
 * ── Hymns ──────────────────────────────────────────────────────────
 *   GET  /hymns
 *   GET  /hymns/:id
 *   GET  /hymns/language/:lang
 *
 * ── Programmes ─────────────────────────────────────────────────────
 *   GET  /programmes
 *   GET  /programmes/:id
 *   GET  /programmes/search
 *   GET  /programme/current
 *   GET  /programme/week
 *   GET  /programme/month
 *   GET  /programme/next
 *   GET  /programme/next-sunday
 *
 * ── Glorias ────────────────────────────────────────────────────────
 *   GET  /glorias
 *   GET  /glorias/:numero
 *
 * ── JIC ────────────────────────────────────────────────────────────
 *   GET  /jic
 *   GET  /jic/:numero
 *
 * ── Updates ────────────────────────────────────────────────────────
 *   GET  /updates
 *   GET  /updates/latest
 *
 * ── Debug ──────────────────────────────────────────────────────────
 *   GET  /mcia/debug/kimi
 *   GET  /mcia/debug/gemini
 */

const PYTHONANYWHERE_BASE = process.env.PYTHONANYWHERE_BASE_URL;
const NVIDIA_API_URL      = process.env.NVIDIA_API_URL;
const GEMINI_API_URL      = process.env.GEMINI_API_URL;

if (!PYTHONANYWHERE_BASE) throw new Error("PYTHONANYWHERE_BASE_URL manquant");
if (!process.env.NVIDIA_API_KEY) console.warn("[MCIA] NVIDIA_API_KEY manquant — Kimi désactivé");
if (!process.env.GEMINI_API_KEY) console.warn("[MCIA] GEMINI_API_KEY manquant — Gemini désactivé");

const TIMEOUT_CHAT = 75000;
const TIMEOUT_PING = 10000;
const TIMEOUT_LLM  = 60000;
const TIMEOUT_DATA = 15000;

const cache     = new Map();
const CACHE_TTL = 1000 * 60 * 2;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", chunk => body += chunk.toString());
    req.on("end", () => {
      try { resolve(JSON.parse(body || "{}")); }
      catch { resolve({}); }
    });
    req.on("error", () => resolve({}));
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
    ),
  ]);
}

// ─── LLM callers ──────────────────────────────────────────────────────────────

async function callNvidiaKimi(messages, model = "moonshotai/kimi-k2.6") {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) throw new Error("NVIDIA_API_KEY manquant");

  const res = await withTimeout(fetch(NVIDIA_API_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type":  "application/json",
      "Accept":        "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.7,
      top_p:       0.95,
      max_tokens:  4096,
      stream:      false,
    }),
  }), TIMEOUT_LLM);

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`NVIDIA ${res.status}: ${err.slice(0, 200)}`);
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || "";
}

async function callGemini(messages) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY manquant");

  const contents = [];
  for (const m of messages) {
    if (m.role === "system") {
      contents.push({ role: "user",  parts: [{ text: "[SYSTEM] " + m.content }] });
      contents.push({ role: "model", parts: [{ text: "Compris." }] });
    } else if (m.role === "assistant") {
      contents.push({ role: "model", parts: [{ text: m.content }] });
    } else {
      contents.push({ role: "user",  parts: [{ text: m.content }] });
    }
  }

  const res = await withTimeout(fetch(GEMINI_API_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/json", "X-goog-api-key": apiKey },
    body: JSON.stringify({
      contents,
      generationConfig: { temperature: 0.7, topP: 0.95, maxOutputTokens: 4096 },
    }),
  }), TIMEOUT_LLM);

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini ${res.status}: ${err.slice(0, 200)}`);
  }
  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

// ─── Forward générique vers PythonAnywhere ────────────────────────────────────

async function forwardToPythonAnywhere(path, options = {}, timeoutMs = TIMEOUT_DATA) {
  const url = PYTHONANYWHERE_BASE + path;
  const res = await withTimeout(fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  }), timeoutMs);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PythonAnywhere ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// ─── Handlers MCIA Chat ───────────────────────────────────────────────────────

async function handleChat(req, res) {
  const body = await readBody(req);
  if (!body.message) return send(res, { error: "message requis" }, 400);

  try {
    const result = await forwardToPythonAnywhere("/mcia/chat", {
      method: "POST",
      body:   JSON.stringify(body),
    }, TIMEOUT_CHAT);
    return send(res, result);
  } catch (paError) {
    console.warn("[MCIA] PythonAnywhere échoué:", paError.message, "— fallback LLM direct");

    const history  = Array.isArray(body.history) ? body.history : [];
    const messages = [
      { role: "system", content: "Tu es MCIA, Maître Chorale IA pour les Cantiques Célestes ECC." },
      ...history,
      { role: "user", content: body.message },
    ];

    try {
      const responseText = await callNvidiaKimi(messages);
      console.log("[MCIA] Kimi fallback OK");
      return send(res, { response: responseText, context_used: null, model_used: "kimi-fallback", error: null });
    } catch (kimiErr) {
      console.warn("[MCIA] Kimi échoué:", kimiErr.message, "— Gemini");
      try {
        const responseText = await callGemini(messages);
        console.log("[MCIA] Gemini fallback OK");
        return send(res, { response: responseText, context_used: null, model_used: "gemini-fallback", error: null });
      } catch (geminiErr) {
        console.error("[MCIA] Tous les providers échoués:", geminiErr.message);
        return send(res, {
          response:     "Service MCIA temporairement indisponible. Réessayez dans quelques instants. 🙏",
          context_used: null,
          model_used:   null,
          error:        "all_providers_failed",
        });
      }
    }
  }
}

async function handlePing(res) {
  const cached = cache.get("ping");
  if (cached && Date.now() - cached.time < CACHE_TTL) return send(res, cached.data);
  try {
    const data = await forwardToPythonAnywhere("/mcia/chat/ping", { method: "GET" }, TIMEOUT_PING);
    cache.set("ping", { data, time: Date.now() });
    return send(res, data);
  } catch (e) {
    return send(res, { status: "error", error: e.message }, 502);
  }
}

// ─── Handler générique (forward transparent) ──────────────────────────────────

async function handleForward(req, res, pathname) {
  // Préserver la query string
  const qs  = req.url.includes("?") ? "?" + req.url.split("?").slice(1).join("?") : "";
  const path = pathname + qs;

  try {
    const opts = { method: req.method };
    if (req.method === "POST" || req.method === "PUT") {
      const body = await readBody(req);
      opts.body  = JSON.stringify(body);
    }
    const data = await forwardToPythonAnywhere(path, opts, TIMEOUT_DATA);
    return send(res, data);
  } catch (e) {
    console.warn("[PROXY]", path, "→", e.message);
    return send(res, { error: e.message }, 502);
  }
}

// ─── Debug ────────────────────────────────────────────────────────────────────

async function handleDebugKimi(res) {
  try {
    const text = await callNvidiaKimi([{ role: "user", content: "ping" }]);
    return send(res, { ok: true, response: text.slice(0, 200), provider: "nvidia/kimi" });
  } catch (e) {
    return send(res, { ok: false, error: e.message }, 502);
  }
}

async function handleDebugGemini(res) {
  try {
    const text = await callGemini([{ role: "user", content: "ping" }]);
    return send(res, { ok: true, response: text.slice(0, 200), provider: "gemini" });
  } catch (e) {
    return send(res, { ok: false, error: e.message }, 502);
  }
}

// ─── Routes data (forward transparent vers PythonAnywhere) ────────────────────

const FORWARD_PREFIXES = [
  "/hymns",
  "/programmes",
  "/programme",
  "/glorias",
  "/jic",
  "/updates",
  "/mcia/cultes",
  "/mcia/cultes-speciaux-v2",
  "/mcia/guide",
  "/mcia/psaumes",
  "/mcia/prieres",
  "/mcia/cantiques-rituel",
  "/mcia/protocole",
  "/mcia/ressources",
  "/mcia/knowledge-base",
  "/mcia/knowledge",
  "/mcia/stats",
  "/mcia/models",
];

// ─── Router principal ─────────────────────────────────────────────────────────

async function handleMciaRoutes(req, res, pathname) {
  try {
    // Chat
    if (pathname === "/mcia/chat" && req.method === "POST")
      return await handleChat(req, res);

    // Ping
    if (pathname === "/mcia/chat/ping" && req.method === "GET")
      return await handlePing(res);

    // Debug
    if (pathname === "/mcia/debug/kimi"   && req.method === "GET") return await handleDebugKimi(res);
    if (pathname === "/mcia/debug/gemini" && req.method === "GET") return await handleDebugGemini(res);

    // Forward transparent pour toutes les autres routes connues
    for (const prefix of FORWARD_PREFIXES) {
      if (pathname === prefix || pathname.startsWith(prefix + "/") || pathname.startsWith(prefix + "?")) {
        return await handleForward(req, res, pathname);
      }
    }

    return send(res, { error: "route inconnue" }, 404);

  } catch (err) {
    console.error("[MCIA] Erreur non gérée:", err);
    return send(res, { error: "internal_error", message: err.message }, 500);
  }
}

// ─── Préfixes à déclarer dans server.js ──────────────────────────────────────
const MCIA_ROUTE_PREFIXES = [
  "/mcia/",
  "/hymns",
  "/programmes",
  "/programme",
  "/glorias",
  "/jic",
  "/updates",
];

module.exports = { handleMciaRoutes, MCIA_ROUTE_PREFIXES };