/**
 * mcia_service.js — Proxy optimisé pour app.py (v3.2)
 * Inclus : Pooling Undici, Forwarding Universel, et Fallback LLM.
 */
const { Pool, fetch: undiciFetch } = require("undici");

const PYTHONANYWHERE_BASE = process.env.PYTHONANYWHERE_BASE_URL;
const NVIDIA_API_URL      = process.env.NVIDIA_API_URL;

if (!PYTHONANYWHERE_BASE) throw new Error("PYTHONANYWHERE_BASE_URL manquant");

// 1. Pool de connexions pour supprimer la latence (Keep-Alive)
const paOrigin = new URL(PYTHONANYWHERE_BASE).origin;
const paPool = new Pool(paOrigin, { connections: 15, keepAliveTimeout: 60000 });

const cache = new Map();
const CACHE_TTL = 1000 * 60 * 5;

// 2. Helper pour lire le corps des requêtes POST/PUT
async function readRawBody(req) {
  return new Promise((resolve) => {
    let chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", () => resolve(Buffer.from("")));
  });
}

// 3. Fallback LLM (Kimi) si PythonAnywhere est hors-ligne
async function callNvidiaKimi(messages) {
  try {
    const res = await undiciFetch(NVIDIA_API_URL, {
      method: "POST",
      headers: { "Authorization": `Bearer ${process.env.NVIDIA_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "moonshotai/kimi-k2.6", messages, temperature: 0.7 }),
    });
    const data = await res.json();
    return data?.choices?.[0]?.message?.content || "Service momentanément indisponible.";
  } catch (e) { return "Erreur de connexion LLM."; }
}

// 4. Forwarder vers PythonAnywhere
async function forwardToPA(path, method, req, timeoutMs = 60000) {
  const url = PYTHONANYWHERE_BASE + path;
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const body = ["POST", "PUT", "PATCH"].includes(method) ? await readRawBody(req) : null;
    const res = await undiciFetch(url, {
      method,
      body,
      dispatcher: paPool,
      signal: ctrl.signal,
      headers: {
        "Content-Type": "application/json",
        "Authorization": req.headers["authorization"] || "",
        "Connection": "keep-alive"
      },
    });
    const text = await res.text();
    clearTimeout(tid);
    return { status: res.status, data: text };
  } catch (e) {
    clearTimeout(tid);
    throw e;
  }
}

// 5. Router Principal
async function handleMciaRoutes(req, res, pathname) {
  const qs = req.url.includes("?") ? "?" + req.url.split("?").slice(1).join("?") : "";
  
  // Cas A : Le Chat avec Fallback
  if (pathname === "/mcia/chat" && req.method === "POST") {
    const rawBody = await readRawBody(req);
    try {
      // On tente PythonAnywhere
      const paRes = await undiciFetch(PYTHONANYWHERE_BASE + pathname, {
        method: "POST", body: rawBody, dispatcher: paPool,
        headers: { "Content-Type": "application/json", "Authorization": req.headers["authorization"] || "" }
      });
      if (paRes.ok) return res.end(await paRes.text());
      throw new Error("PA Error");
    } catch (e) {
      // Fallback Kimi
      const body = JSON.parse(rawBody.toString() || "{}");
      const messages = [{ role: "system", content: "Tu es MCIA." }, ...(body.history || []), { role: "user", content: body.message }];
      const response = await callNvidiaKimi(messages);
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ response, model_used: "kimi-fallback" }));
    }
  }

  // Cas B : Le Ping (avec Cache)
  if (pathname === "/mcia/chat/ping") {
    const cached = cache.get("ping");
    if (cached && Date.now() - cached.time < CACHE_TTL) {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(cached.data);
    }
  }

  // Cas C : Toutes les autres routes (Hymnes, Programmes, Glorias, JIC, etc.)
  try {
    const result = await forwardToPA(pathname + qs, req.method, req);
    if (pathname === "/mcia/chat/ping") cache.set("ping", { data: result.data, time: Date.now() });
    res.writeHead(result.status, { "Content-Type": "application/json" });
    res.end(result.data);
  } catch (err) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Upstream down" }));
  }
}

module.exports = { handleMciaRoutes };
