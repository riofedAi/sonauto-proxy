/**
 * mcia_service.js — MCIA proxy module for Render
 * Forwards /mcia/* requests to PythonAnywhere + direct LLM fallback
 *
 * Routes exposed:
 *   POST /mcia/chat
 *   GET  /mcia/chat/ping
 *   GET  /mcia/models
 *   GET  /mcia/cultes
 *   GET  /mcia/cultes/:id
 *   GET  /mcia/debug/kimi
 *   GET  /mcia/debug/gemini
 *   GET  /hymns
 *   GET  /hymns/:id
 *   GET  /hymns/language/:lang
 *   GET  /programmes
 *   GET  /programmes/:id
 *   GET  /programmes/search
 *   GET  /programme/current
 *   GET  /programme/week
 *   GET  /programme/month
 *   GET  /programme/next
 *   GET  /programme/next-sunday
 */

const PYTHONANYWHERE_BASE = process.env.PYTHONANYWHERE_BASE_URL;
const NVIDIA_API_URL      = process.env.NVIDIA_API_URL;
const GEMINI_API_URL      = process.env.GEMINI_API_URL;

if (!PYTHONANYWHERE_BASE) throw new Error("PYTHONANYWHERE_BASE_URL manquant dans les variables d'environnement");
if (!process.env.NVIDIA_API_KEY) console.warn("[MCIA] NVIDIA_API_KEY manquant — Kimi désactivé");
if (!process.env.GEMINI_API_KEY) console.warn("[MCIA] GEMINI_API_KEY manquant — Gemini désactivé");

const TIMEOUT_CHAT = 75000;
const TIMEOUT_PING = 10000;
const TIMEOUT_LLM  = 60000;

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
      setTimeout(() => reject(new Error("timeout after " + ms + "ms")), ms)
    )
  ]);
}

function geminiHeaders(apiKey) {
  return {
    "Content-Type": "application/json",
    "X-goog-api-key": apiKey,
  };
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
    headers: geminiHeaders(apiKey),
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

// ─── Forward vers PythonAnywhere ──────────────────────────────────────────────

async function forwardToPythonAnywhere(path, options = {}, timeoutMs = TIMEOUT_CHAT) {
  const url = PYTHONANYWHERE_BASE + path;
  const res = await withTimeout(fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  }), timeoutMs);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PythonAnywhere ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

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
      { role: "system", content: "Tu es MCIA, Maître Chorale IA pour les Cantiques Célestes." },
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
        console.error("[MCIA] Tous les providers ont échoué:", geminiErr.message);
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

async function handleModels(res) {
  try {
    const data = await forwardToPythonAnywhere("/mcia/models", { method: "GET" }, 10000);
    return send(res, data);
  } catch (e) {
    return send(res, { models: ["kimi", "gemini"], error: e.message });
  }
}

async function handleCultes(res, culteId) {
  try {
    const path = culteId ? `/mcia/cultes/${encodeURIComponent(culteId)}` : "/mcia/cultes";
    const data = await forwardToPythonAnywhere(path, { method: "GET" }, 10000);
    return send(res, data);
  } catch (e) {
    return send(res, { error: e.message }, 502);
  }
}

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

// ─── Forward transparent (hymns, programmes, etc.) ────────────────────────────

async function handleDataForward(req, res, pathname) {
  try {
    const qs   = req.url.includes("?") ? "?" + req.url.split("?").slice(1).join("?") : "";
    const data = await forwardToPythonAnywhere(pathname + qs, { method: "GET" }, 15000);
    return send(res, data);
  } catch (e) {
    console.warn("[PROXY]", pathname, "→", e.message);
    return send(res, { error: e.message }, 502);
  }
}

// ─── Router ───────────────────────────────────────────────────────────────────

async function handleMciaRoutes(req, res, pathname) {
  try {
    // Chat
    if (pathname === "/mcia/chat" && req.method === "POST")
      return await handleChat(req, res);

    // Ping
    if (pathname === "/mcia/chat/ping" && req.method === "GET")
      return await handlePing(res);

    // Models
    if (pathname === "/mcia/models" && req.method === "GET")
      return await handleModels(res);

    // Cultes
    if (pathname === "/mcia/cultes" && req.method === "GET")
      return await handleCultes(res, null);
    if (pathname.startsWith("/mcia/cultes/") && req.method === "GET")
      return await handleCultes(res, pathname.replace("/mcia/cultes/", ""));

    // Debug
    if (pathname === "/mcia/debug/kimi"   && req.method === "GET") return await handleDebugKimi(res);
    if (pathname === "/mcia/debug/gemini" && req.method === "GET") return await handleDebugGemini(res);

    // Hymns — forward direct vers PythonAnywhere
    if (pathname.startsWith("/hymns"))
      return await handleDataForward(req, res, pathname);

    // Programmes — forward direct vers PythonAnywhere
    if (pathname.startsWith("/programmes") || pathname.startsWith("/programme"))
      return await handleDataForward(req, res, pathname);

    return send(res, { error: "route MCIA inconnue" }, 404);

  } catch (err) {
    console.error("[MCIA] Erreur non gérée:", err);
    return send(res, { error: "internal_error", message: err.message }, 500);
  }
}

module.exports = { handleMciaRoutes };
