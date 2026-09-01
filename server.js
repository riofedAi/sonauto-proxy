/**
 * server_fixed.js — Music AI Proxy + MCIA Proxy (FIX 2026-08-31 + COMPO PRO v2)
 * Base : server.js déployé ("Undici-KeepAlive", 219 lignes) — contrats inchangés.
 *
 * ─── v1 (FIX 2026-08-31, DÉPLOYÉ) : runAcestepGeneration robuste ─────────────
 *   api.acemusic.ai renvoie parfois 504 + HTML Cloudflare (~61s) → r.json() nu
 *   plantait ("Unexpected token <"). FIX : lecture TEXTE + JSON.parse contrôlé
 *   + retry automatique + message d'erreur explicite.
 *
 * ─── v2 (COMPO PRO 2026-08-31) : qualité + durée professionnelles ────────────
 *   1. thinking TOUJOURS ACTIVÉ côté ACE-Step (exigence produit : meilleure
 *      qualité de composition). L'APK envoyait thinking=true/false selon le
 *      retry mais le serveur l'écrasait avec false codé en dur → mode "réflexion"
 *      du moteur jamais utilisé. Désormais : true par défaut, désactivable
 *      via env ACESTEP_THINKING=false (aucun impact client).
 *   2. DURÉE : l'APK envoie maintenant une durée CALCULÉE d'après la longueur
 *      des paroles (3-5 min par défaut). Le proxy clamp la valeur reçue entre
 *      30 et 480 s et utilise 240 s si absente (au lieu de 60 s).
 *   3. MAX_UPSTREAM_ATTEMPTS : 2 → 3 (les morceaux de 3-5 min passent plus
 *      de temps amont → plus de chances de croiser une 504 Cloudflare).
 *
 *   /generate, /status, /download, song_paths relatif, rate limit, CORS,
 *   forwarding PythonAnywhere : IDENTIQUES ("ne casse rien").
 *
 * Env : MAX_UPSTREAM_ATTEMPTS (déf 3), UPSTREAM_RETRY_DELAY_MS (déf 3000),
 *       ACESTEP_THINKING (déf true), ACESTEP_DEFAULT_DURATION (déf 240),
 *       ACESTEP_MAX_DURATION (déf 480)
 */

require("dotenv").config();
const http          = require("http");
const fs            = require("fs");
const path          = require("path");
const urlModule     = require("url");
const { pipeline }  = require("stream");
const { promisify } = require("util");
const { Agent, setGlobalDispatcher, fetch: undiciFetch } = require("undici");

const streamPipeline = promisify(pipeline);
const { handleMciaRoutes } = require("./mcia_service");

// ─── OPTIMISATION RÉSEAU (Keep-Alive Global) ────────────────────────────────
const globalDispatcher = new Agent({
  connections: 25,
  keepAliveTimeout: 60000,
  keepAliveMaxTimeout: 300000,
});
setGlobalDispatcher(globalDispatcher);

// ─── CONFIGURATION ───────────────────────────────────────────────────────────
const PORT              = process.env.PORT || 3000;
const SONAUTO_API_KEY   = process.env.EXPO_PUBLIC_SONAUTO_API_KEY;
const ACESTEP_API_KEY   = process.env.ACESTEP_API_KEY || "";
const ACESTEP_BASE_URL  = process.env.ACESTEP_BASE_URL || "https://api.acemusic.ai";
const CLIENT_API_KEY    = process.env.CLIENT_API_KEY || null;
const AUTO_DOWNLOAD     = process.env.AUTO_DOWNLOAD === "true";
const SONAUTO_BASE_URL  = "https://api.sonauto.ai/v1";
const IN_MEMORY_TTL     = parseInt(process.env.IN_MEMORY_TTL_MS) || 30 * 60 * 1000;
const DAILY_LIMIT       = parseInt(process.env.DAILY_LIMIT) || 8;
const MAX_BODY_SIZE     = (parseInt(process.env.MAX_BODY_SIZE_MB) || 25) * 1024 * 1024;
const MAX_AUDIO_BASE64  = 15 * 1024 * 1024;
// FIX : retry amont
const MAX_UPSTREAM_ATTEMPTS = parseInt(process.env.MAX_UPSTREAM_ATTEMPTS) || 3;
const UPSTREAM_RETRY_DELAY_MS = parseInt(process.env.UPSTREAM_RETRY_DELAY_MS) || 3000;
// v2 COMPO PRO : thinking toujours actif + durée clampée (paroles longues = morceau long)
const ACESTEP_THINKING = process.env.ACESTEP_THINKING !== "false"; // défaut TRUE
const ACESTEP_DEFAULT_DURATION = parseInt(process.env.ACESTEP_DEFAULT_DURATION) || 240;
const ACESTEP_MAX_DURATION = parseInt(process.env.ACESTEP_MAX_DURATION) || 480;
function resolveAcestepDuration(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return ACESTEP_DEFAULT_DURATION;
  return Math.min(ACESTEP_MAX_DURATION, Math.max(30, n));
}

// ─── IN-MEMORY STORE (ACE-Step audio) ────────────────────────────────────────
const audioStore = new Map();

function storeAudio(taskId, buffer) {
  audioStore.set(taskId, { buffer, expiresAt: Date.now() + IN_MEMORY_TTL });
  setTimeout(() => audioStore.delete(taskId), IN_MEMORY_TTL);
}

function storeError(taskId, message) {
  audioStore.set(taskId, { error: message, expiresAt: Date.now() + IN_MEMORY_TTL });
  setTimeout(() => audioStore.delete(taskId), IN_MEMORY_TTL);
}

// ─── RATE LIMITER ─────────────────────────────────────────────────────────────
const rateMap = new Map();
function getToday() {
  const d = new Date();
  return d.toISOString().split("T")[0];
}
function getClientIP(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.headers["x-real-ip"] || req.socket.remoteAddress || "unknown";
}
function checkRateLimit(ip) {
  const today = getToday();
  const entry = rateMap.get(ip);
  if (!entry || entry.date !== today) { rateMap.set(ip, { date: today, count: 0 }); return true; }
  return entry.count < DAILY_LIMIT;
}
function incrementRate(ip) {
  const today = getToday();
  const entry = rateMap.get(ip);
  if (!entry || entry.date !== today) { rateMap.set(ip, { date: today, count: 1 }); }
  else { entry.count++; }
}

// ─── S3 & DISK ────────────────────────────────────────────────────────────────
const OUTPUT_DIR = path.join(__dirname, "songs");
if (AUTO_DOWNLOAD && !fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

let s3 = null;
const USE_S3 = !!(process.env.AWS_S3_BUCKET && process.env.AWS_ACCESS_KEY_ID);
if (USE_S3) {
  try {
    const AWS = require("aws-sdk");
    s3 = new AWS.S3({ region: process.env.AWS_REGION || "us-east-1" });
  } catch { console.warn("[proxy] aws-sdk not found"); }
}

// ─── UTILITIES ────────────────────────────────────────────────────────────────
async function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ""; let total = 0;
    req.on("data", c => { total += c.length; if (total > MAX_BODY_SIZE) { req.destroy(); return reject(new Error("Payload too large")); } raw += c; });
    req.on("end", () => { try { resolve(JSON.parse(raw || "{}")); } catch (e) { reject(new Error("Invalid JSON")); } });
  });
}

function jsonRes(res, status, body) {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

// ─── SONAUTO LOGIC ───────────────────────────────────────────────────────────
async function sonautoCall(endpoint, method = "GET", body = null) {
  const opts = { method, headers: { Authorization: `Bearer ${SONAUTO_API_KEY}`, "Content-Type": "application/json" } };
  if (body) opts.body = JSON.stringify(body);
  const r = await undiciFetch(`${SONAUTO_BASE_URL}${endpoint}`, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Sonauto: ${JSON.stringify(data)}`);
  return data;
}

async function pollSonauto(taskId, mode) {
  let attempt = 0;
  while (attempt < 60) {
    attempt++;
    try {
      const data = await sonautoCall(`/generations/${taskId}`);
      if (data.status === "SUCCESS") return;
      if (data.status === "FAILURE") return;
    } catch {}
    await new Promise(r => setTimeout(r, 5000));
  }
}

// ─── ACE-STEP LOGIC ──────────────────────────────────────────────────────────
// ★ FIX 2026-08-31 : parse robuste du texte amont + retry sur HTML/non-JSON.
// L'ancien code : `const data = await r.json()` → "Unexpected token < in JSON
// at position 0" dès que Cloudflare renvoyait sa page 504 HTML (~61s).
async function runAcestepGeneration(taskId, payload) {
  let lastErr = "";
  for (let attempt = 1; attempt <= MAX_UPSTREAM_ATTEMPTS; attempt++) {
    try {
      const headers = { "Content-Type": "application/json", "Authorization": `Bearer ${ACESTEP_API_KEY}` };
      const r = await undiciFetch(`${ACESTEP_BASE_URL}/v1/chat/completions`, {
        method: "POST", headers, body: JSON.stringify({
          model: payload.model || "acemusic/acestep-v1.5-xl-turbo",
          messages: payload.messages,
          duration: resolveAcestepDuration(payload.duration),
          // ★ v2 COMPO PRO : thinking TOUJOURS activé côté moteur (exigence produit).
          // L'ancien code forçait false ici, écrasant le choix de l'APK.
          thinking: ACESTEP_THINKING
        })
      });
      // ★ FIX 1 : texte d'abord — un HTML amont ne fait plus planter en exception opaque
      const text = await r.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        const isHtml = /<html|<!doctype/i.test(text.slice(0, 500));
        throw new Error(
          isHtml
            ? `Amont ACE-Step a renvoyé du HTML (HTTP ${r.status}, probablement 504 Cloudflare — génération trop longue côté amont)`
            : `Amont ACE-Step a renvoyé du non-JSON (HTTP ${r.status})`
        );
      }
      const audioUrl = data?.choices?.[0]?.message?.audio?.[0]?.audio_url?.url || data?.choices?.[0]?.message?.audio_url;
      if (!audioUrl) throw new Error(`No audio URL (HTTP ${r.status})`);

      const buffer = Buffer.from(audioUrl.replace(/^data:audio\/\w+;base64,/, ""), "base64");
      storeAudio(taskId, buffer);
      if (AUTO_DOWNLOAD) fs.writeFileSync(path.join(OUTPUT_DIR, `${taskId}.mp3`), buffer);
      if (USE_S3) await s3.putObject({ Bucket: process.env.AWS_S3_BUCKET, Key: `acemusic/${taskId}.mp3`, Body: buffer }).promise();
      console.log(`[acestep] ${taskId} — SUCCESS (essai ${attempt}/${MAX_UPSTREAM_ATTEMPTS}, ${buffer.length} octets)`);
      return; // succès → stop
    } catch (err) {
      lastErr = err && err.message ? err.message : String(err);
      console.error(`[acestep] ${taskId} — essai ${attempt}/${MAX_UPSTREAM_ATTEMPTS} échoué: ${lastErr}`);
      if (attempt < MAX_UPSTREAM_ATTEMPTS) {
        await new Promise(r2 => setTimeout(r2, UPSTREAM_RETRY_DELAY_MS));
      }
    }
  }
  // ★ FIX 3 : message final explicite (l'APK affichera une cause compréhensible)
  storeError(taskId, `Génération ACE-Step indisponible après ${MAX_UPSTREAM_ATTEMPTS} essais (${lastErr})`);
}

// ─── HTTP SERVER ──────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const { pathname, query } = urlModule.parse(req.url, true);

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-KEY, X-CLIENT-KEY");
  if (req.method === "OPTIONS") { res.writeHead(200); return res.end(); }

  // ── ROUTES MCIA & APP.PY (Synchronisées) ───────────────────────────────────
  const paPrefixes = ["/mcia", "/hymns", "/programmes", "/programme", "/import-programmes", "/glorias", "/jic", "/updates", "/login"];
  if (paPrefixes.some(p => pathname.startsWith(p))) {
    return handleMciaRoutes(req, res, pathname);
  }

  // ── ROUTES MUSIQUE (ACE-Step / Sonauto) ────────────────────────────────────
  if (pathname === "/generate" && req.method === "POST") {
    const ip = getClientIP(req);
    if (!checkRateLimit(ip)) return jsonRes(res, 429, { error: "Limit reached" });
    let body;
    try { body = await parseBody(req); }
    catch (e) { return jsonRes(res, 400, { error: e.message }); }
    const taskId = `${body.engine || "acestep"}-${Date.now()}`;
    incrementRate(ip);
    jsonRes(res, 200, { status: "SUBMITTED", taskId });

    if (body.engine === "sonauto") {
      const gen = await sonautoCall("/generations/v3", "POST", body).catch(e => console.error(e));
      if (gen?.task_id) pollSonauto(gen.task_id, body.mode);
    } else {
      runAcestepGeneration(taskId, body);
    }
    return;
  }

  if (pathname.startsWith("/status/")) {
    const taskId = pathname.split("/")[2];
    if (taskId.startsWith("acestep")) {
      const entry = audioStore.get(taskId);
      if (!entry) return jsonRes(res, 200, { status: "PROCESSING" });
      if (entry.error) return jsonRes(res, 200, { status: "FAILURE", message: entry.error });
      return jsonRes(res, 200, { status: "SUCCESS", song_paths: [`/download/${taskId}`] });
    }
    const data = await sonautoCall(`/generations/${taskId}`).catch(e => ({ error: e.message }));
    return jsonRes(res, 200, data);
  }

  if (pathname.startsWith("/download/")) {
    const taskId = pathname.split("/")[2];
    const entry = audioStore.get(taskId);
    if (entry?.buffer) {
      res.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Length": entry.buffer.length });
      return res.end(entry.buffer);
    }
    return jsonRes(res, 404, { error: "Not found" });
  }
  // ── UI ──────────────────────────────────────────────────────────────────
  if ((pathname === "/" || pathname === "/ui") && req.method === "GET") {
    const htmlPath = path.join(__dirname, "public", "index.html");
    if (fs.existsSync(htmlPath)) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(fs.readFileSync(htmlPath, "utf-8"));
    }
    return jsonRes(res, 404, { error: "UI not found" });
  }

  // Health check
  if (pathname === "/health") return jsonRes(res, 200, {
    status: "ok",
    engine: "Undici-KeepAlive-FIX2",
    maxUpstreamAttempts: MAX_UPSTREAM_ATTEMPTS,
    thinking: ACESTEP_THINKING,
    defaultDurationSec: ACESTEP_DEFAULT_DURATION,
    maxDurationSec: ACESTEP_MAX_DURATION,
  });

  jsonRes(res, 404, { error: "Not Found" });
});

server.listen(PORT, () => console.log(`[Server] Port ${PORT} - Musique + MCIA Ready (FIX2 COMPO PRO: thinking=${ACESTEP_THINKING}, dur ${ACESTEP_DEFAULT_DURATION}-${ACESTEP_MAX_DURATION}s, retry amont x${MAX_UPSTREAM_ATTEMPTS})`));
