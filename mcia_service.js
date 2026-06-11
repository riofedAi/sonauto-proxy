/**
 * mcia_service.js — Proxy optimisé pour app.py (v3.2)
 * Inclus : Pooling Undici, Forwarding Universel, et Fallback LLM.
 * Modifié pour rendre PYTHONANYWHERE_BASE_URL optionnel afin d'éviter que
 * le processus plante lorsqu'il n'est pas configuré (déploiement sur Render).
 */
const { Pool, fetch: undiciFetch } = require("undici");

// Lire la configuration d'environnement, tolérante aux valeurs manquantes
const PYTHONANYWHERE_BASE = process.env.PYTHONANYWHERE_BASE_URL || null;
const NVIDIA_API_URL      = process.env.NVIDIA_API_URL || null;

if (!PYTHONANYWHERE_BASE) {
  console.warn("[mcia_service] PYTHONANYWHERE_BASE_URL non configuré — forwarding vers PythonAnywhere désactivé. Le fallback LLM sera utilisé pour /mcia/chat.");
}

// 1. Pool de connexions pour supprimer la latence (Keep-Alive) — créé seulement si on a une base
let paPool = null;
if (PYTHONANYWHERE_BASE) {
  const paOrigin = new URL(PYTHONANYWHERE_BASE).origin;
  paPool = new Pool(paOrigin, { connections: 15, keepAliveTimeout: 60000 });
}

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
  if (!NVIDIA_API_URL) return "Service LLM non configuré.";
  try {
    const res = await undiciFetch(NVIDIA_API_URL, {
      method: "POST",
      headers: { "Authorization": `Bearer ${process.env.NVIDIA_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "moonshotai/kimi-k2.6", messages, temperature: 0.7 }),
    });
    const data = await res.json().catch(() => ({}));
    return data?.choices?.[0]?.message?.content || data?.message || "Service momentanément indisponible.";
  } catch (e) { return "Erreur de connexion LLM."; }
}

// 4. Forwarder vers PythonAnywhere
async function forwardToPA(path, method, req, timeoutMs = 60000) {
  if (!PYTHONANYWHERE_BASE || !paPool) throw new Error("PYTHONANYWHERE_BASE_URL non configuré");
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
      // Si PythonAnywhere est configuré, on tente d'abord
      if (PYTHONANYWHERE_BASE) {
        const paRes = await undiciFetch(PYTHONANYWHERE_BASE + pathname, {
          method: "POST", body: rawBody, dispatcher: paPool,
          headers: { "Content-Type": "application/json", "Authorization": req.headers["authorization"] || "" }
        });
        if (paRes.ok) {
          res.writeHead(paRes.status, { "Content-Type": paRes.headers.get("content-type") || "application/json" });
          return res.end(await paRes.text());
        }
        // si PA répond mais pas OK, on tombe en fallback
      }
    } catch (e) {
      // continue vers fallback
      console.warn("[mcia_service] forward to PA failed:", e && e.message ? e.message : e);
    }

    // Fallback Kimi
    let body = {};
    try { body = JSON.parse(rawBody.toString() || "{}"); } catch {}
    const messages = [{ role: "system", content: "Tu es MCIA." }, ...(body.history || []), { role: "user", content: body.message || body.input || "" }];
    const response = await callNvidiaKimi(messages);
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ response, model_used: "kimi-fallback" }));
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
    // Si PA n'est pas configuré, renvoyer une erreur upstream claire
    if (!PYTHONANYWHERE_BASE) {
      res.writeHead(502, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Upstream (PythonAnywhere) non configuré" }));
    }

    const result = await forwardToPA(pathname + qs, req.method, req);
    if (pathname === "/mcia/chat/ping") cache.set("ping", { data: result.data, time: Date.now() });
    res.writeHead(result.status, { "Content-Type": "application/json" });
    res.end(result.data);
  } catch (err) {
    console.warn("[mcia_service] forwardToPA error:", err && err.message ? err.message : err);
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Upstream down" }));
  }
}

module.exports = { handleMciaRoutes };