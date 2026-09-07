/**
 * server.js — Music AI Proxy v2.1 (2026-09-07)
 * ============================================
 * Moteur principal : TREBLO (https://api.treblo.com/v1)
 *   - POST /generations/{version}  → { task_id }
 *   - GET  /generations/status/{task_id} → CHAÎNE JSON brute ("GENERATING",
 *     "SUCCESS", "FAILURE") — PAS un objet {status:...} (vérifié en prod)
 *   - GET  /generations/{task_id}  → objet complet { status, song_paths: [...] }
 *     (les URLs CDN éphémères sont ICI, jamais dans /status)
 *   - Auth : Authorization: Bearer <clé>
 *
 * NOUVEAUTÉS v2 (demande produit 2026-09-07) :
 *   1. POOL DE CLÉS TREBLO : les clés viennent d'un fichier `treblo_keys.json`
 *      (rechargé à chaud) et/ou de la variable d'env TREBLO_API_KEYS (séparées
 *      par des virgules). En cas d'erreur 429 (limite de débit), le serveur
 *      BASCULE AUTOMATIQUEMENT sur la clé suivante de la liste.
 *   2. Clés 401/402/403 (invalide / sans crédits) désactivées automatiquement.
 *   3. IDs de tâche LOCAUX NEUTRES ("mus-...") — aucun nom de moteur amont
 *      n'apparaît dans les réponses, les messages d'erreur ni les IDs
 *      (exigence de non-divulgation). Un moteur secondaire optionnel
 *      "engineB" reste disponible, configurable UNIQUEMENT par variables
 *      d'environnement (son nom n'est écrit nulle part dans ce fichier).
 *   4. /status consulte D'ABORD le store local (correctif du bug
 *      "uuid_parsing" : l'ancienne version interrogeait l'amont avec l'ID
 *      local au lieu de l'ID amont réel).
 *   5. Compatibilité ascendante : accepte l'ancien format APK
 *      (payload.messages avec <prompt>…</prompt><lyrics>…</lyrics>) ET le
 *      nouveau format propre { prompt, lyrics, duration, ... }.
 *
 * Contrat client (inchangé pour l'APK) :
 *   POST /generate        → { status:"SUBMITTED", taskId } | erreur { error_code }
 *   GET  /status/:taskId  → { status:"PROCESSING"|"SUCCESS"|"FAILURE",
 *                             song_paths?:[...], error_message?, error_code? }
 *   GET  /download/:taskId → fichier MP3
 *   GET  /health
 *
 * Variables d'environnement :
 *   TREBLO_API_KEYS          — clés séparées par virgules (ou fichier JSON)
 *   TREBLO_BASE_URL          — défaut: https://api.treblo.com/v1
 *   TREBLO_MODEL_VERSION     — "v3" (défaut, bêta) ou "v2" (déprécié)
 *   TREBLO_KEYS_FILE         — défaut: ./treblo_keys.json
 *   KEY_COOLDOWN_MS          — pause d'une clé après 429 (défaut: 90000)
 *   ENABLE_ENGINEB           — "true" pour activer le moteur secondaire
 *   ENGINEB_BASE_URL         — URL du moteur secondaire (aucun défaut)
 *   ENGINEB_API_KEY          — clé du moteur secondaire
 *   CLIENT_API_KEY           — protège /generate (header X-CLIENT-KEY)
 *   PORT / DAILY_LIMIT / MAX_BODY_SIZE_MB / IN_MEMORY_TTL_MS
 *   AUTO_DOWNLOAD / AWS_S3_BUCKET / AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION
 *   KEEP_ALIVE_URL / KEEP_ALIVE_INTERVAL_MS
 *   MAX_POLL_ATTEMPTS / POLL_BASE_DELAY_MS
 *   DOWNLOAD_HOST_ALLOWLIST  — hôtes autorisés pour /download?url=… (défaut: treblo.ai)
 *
 * Node.js 18+ (fetch global).
 */

// dotenv optionnel : sur Railway/Render les variables d'env sont injectées
// nativement — le proxy démarre même sans le paquet.
try { require("dotenv").config(); } catch { /* pas de dotenv : env plateforme */ }

const http          = require("http");
const fs            = require("fs");
const path          = require("path");
const urlModule     = require("url");
const crypto       = require("crypto");
const { pipeline }  = require("stream");
const { promisify } = require("util");
const streamPipeline = promisify(pipeline);

// ─── Config ──────────────────────────────────────────────────────────────────

const PORT               = process.env.PORT || 3000;
const TREBLO_BASE_URL    = (process.env.TREBLO_BASE_URL || "https://api.treblo.com/v1").replace(/\/+$/, "");
const TREBLO_MODEL       = process.env.TREBLO_MODEL_VERSION || "v3";
const TREBLO_KEYS_FILE   = process.env.TREBLO_KEYS_FILE || path.join(__dirname, "treblo_keys.json");
const KEY_COOLDOWN_MS    = parseInt(process.env.KEY_COOLDOWN_MS) || 90000;
const CLIENT_API_KEY     = process.env.CLIENT_API_KEY || null;
const AUTO_DOWNLOAD      = process.env.AUTO_DOWNLOAD === "true";
const IN_MEMORY_TTL      = parseInt(process.env.IN_MEMORY_TTL_MS) || 30 * 60 * 1000;
const DAILY_LIMIT        = parseInt(process.env.DAILY_LIMIT) || 8;
const MAX_BODY_SIZE      = (parseInt(process.env.MAX_BODY_SIZE_MB) || 25) * 1024 * 1024;
const MAX_POLL_ATTEMPTS  = parseInt(process.env.MAX_POLL_ATTEMPTS) || 100;
const POLL_BASE_DELAY_MS = parseInt(process.env.POLL_BASE_DELAY_MS) || 6000;

// Moteur secondaire optionnel — identifié uniquement par son code interne
// "engineB". Aucun nom de fournisseur n'est écrit dans ce fichier.
const ENABLE_ENGINEB     = process.env.ENABLE_ENGINEB === "true";
const ENGINEB_BASE_URL   = (process.env.ENGINEB_BASE_URL || "").replace(/\/+$/, "");
const ENGINEB_API_KEY    = process.env.ENGINEB_API_KEY || "";

const DOWNLOAD_ALLOWLIST = (process.env.DOWNLOAD_HOST_ALLOWLIST || "treblo.ai,treblo.com,cdn.treblo.com")
  .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

// ─── Pool de clés Treblo ─────────────────────────────────────────────────────

let keyFileMtime = 0;
function loadKeys() {
  const keys = [];
  // 1. Fichier JSON (rechargé à chaud si mtime change)
  try {
    const st = fs.statSync(TREBLO_KEYS_FILE);
    if (st.mtimeMs !== keyFileMtime) {
      keyFileMtime = st.mtimeMs;
      console.log("[keys] rechargement de", TREBLO_KEYS_FILE);
    }
    const raw = JSON.parse(fs.readFileSync(TREBLO_KEYS_FILE, "utf8"));
    const arr = Array.isArray(raw) ? raw : (Array.isArray(raw.keys) ? raw.keys : []);
    for (const k of arr) {
      if (typeof k === "string" && k.trim()) keys.push(k.trim());
    }
  } catch { /* fichier absent ou illisible — on continue avec l'env */ }
  // 2. Variable d'environnement (séparées par virgules)
  for (const k of (process.env.TREBLO_API_KEYS || "").split(",")) {
    if (k.trim()) keys.push(k.trim());
  }
  // Déduplication en préservant l'ordre
  return [...new Set(keys)];
}

// État par clé : cooldown (429) ou désactivation (401/402/403)
const keyState = new Map(); // clé → { cooldownUntil, disabled, lastError }
function keyInfo(k) {
  if (!keyState.has(k)) keyState.set(k, { cooldownUntil: 0, disabled: false, lastError: null });
  return keyState.get(k);
}
function activeKeys() {
  const now = Date.now();
  return loadKeys().filter(k => {
    const s = keyInfo(k);
    return !s.disabled && s.cooldownUntil <= now;
  });
}
let rrIndex = 0; // round-robin
function pickKey() {
  const keys = loadKeys();
  if (!keys.length) return null;
  const active = activeKeys();
  if (!active.length) return null;
  // Part du round-robin global, retombe sur la première clé active trouvée
  for (let i = 0; i < keys.length; i++) {
    const candidate = keys[(rrIndex + i) % keys.length];
    if (active.includes(candidate)) { rrIndex = (rrIndex + i + 1) % keys.length; return candidate; }
  }
  return null;
}
function markRateLimited(k) {
  const s = keyInfo(k);
  s.cooldownUntil = Date.now() + KEY_COOLDOWN_MS;
  s.lastError = "429";
  console.log(`[keys] clé #${loadKeys().indexOf(k) + 1} en pause ${KEY_COOLDOWN_MS / 1000}s (429) — rotation`);
}
function markDead(k, status) {
  const s = keyInfo(k);
  s.disabled = true;
  s.lastError = String(status);
  console.log(`[keys] clé #${loadKeys().indexOf(k) + 1} DÉSACTIVÉE (HTTP ${status})`);
}

// ─── Messages d'erreur NEUTRES (non-divulgation) ─────────────────────────────
// Aucun nom de moteur, aucun domaine amont, aucun détail brut de l'amont
// ne doit sortir vers le client. Les détails techniques restent en console.

const NEUTRAL_ERRORS = {
  rate_limited:      { message: "Le service de musique est très sollicité pour le moment. Réessayez dans quelques minutes.", status: 429 },
  no_keys:           { message: "Le service de musique est momentanément indisponible.", status: 503 },
  upstream_error:    { message: "La génération musicale n'a pas pu être démarrée cette fois-ci.", status: 502 },
  upstream_failed:   { message: "La génération musicale n'a pas abouti cette fois-ci. Réessayez.", status: 200 },
  timeout:           { message: "La génération musicale a pris trop de temps. Réessayez.", status: 200 },
  expired:           { message: "Audio expiré ou introuvable. Relancez la génération.", status: 404 },
  bad_request:       { message: "Requête invalide.", status: 400 },
};

function neutralError(code, extra) {
  const base = NEUTRAL_ERRORS[code] || NEUTRAL_ERRORS.upstream_error;
  return { status: base.status, body: { status: "ERROR", error_code: code, message: base.message, ...(extra || {}) } };
}

function logUpstream(context, err) {
  // Journal serveur uniquement — jamais renvoyé au client.
  console.error(`[upstream:${context}]`, err && err.message ? err.message : err);
}

// ─── Store des tâches + audio ────────────────────────────────────────────────

// taskStore : localId → { engine:'treblo'|'engineb', upstreamId, key, title,
//                         phase:'processing'|'ready'|'error', errorCode,
//                         songPath (URL CDN au SUCCESS), createdAt }
const taskStore  = new Map();
// audioStore : localId → { buffer, expiresAt } | { error }
const audioStore = new Map();

function newLocalId() {
  return `mus-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
}

function storeAudio(taskId, buffer) {
  audioStore.set(taskId, { buffer, expiresAt: Date.now() + IN_MEMORY_TTL });
  setTimeout(() => { if (audioStore.get(taskId)?.expiresAt <= Date.now()) audioStore.delete(taskId); }, IN_MEMORY_TTL + 1000);
}

// ─── Rate limiter (par IP, quotidien) ────────────────────────────────────────

const rateMap = new Map();
function getToday() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function getClientIP(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0]?.trim()
    || req.headers["x-real-ip"]
    || req.socket.remoteAddress
    || "unknown";
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
  if (!entry || entry.date !== today) rateMap.set(ip, { date: today, count: 1 });
  else entry.count += 1;
}
setInterval(() => {
  const today = getToday();
  for (const [ip, entry] of rateMap) if (entry.date !== today) rateMap.delete(ip);
}, 3600000);

// ─── Sorties optionnelles (S3 / disque) ──────────────────────────────────────

const OUTPUT_DIR = path.join(__dirname, "songs");
if (AUTO_DOWNLOAD && !fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

let s3 = null;
const USE_S3 = !!(process.env.AWS_S3_BUCKET && process.env.AWS_ACCESS_KEY_ID);
if (USE_S3) {
  try {
    const AWS = require("aws-sdk");
    AWS.config.update({ region: process.env.AWS_REGION || "us-east-1" });
    s3 = new AWS.S3();
  } catch { console.warn("[proxy] aws-sdk absent — S3 désactivé"); }
}

// ─── Utilitaires HTTP ────────────────────────────────────────────────────────

async function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "", total = 0;
    req.on("data", c => {
      total += c.length;
      if (total > MAX_BODY_SIZE) { req.destroy(); return reject(new Error("Payload too large")); }
      raw += c;
    });
    req.on("end", () => {
      try { resolve(JSON.parse(raw || "{}")); } catch { reject(new Error("Invalid JSON body")); }
    });
    req.on("error", reject);
  });
}

function jsonRes(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function fetchWithTimeout(url, opts = {}, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeoutMs);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(tid));
}

// ─── Appels Treblo AVEC ROTATION DE CLÉS ─────────────────────────────────────
// Erreur typée : err.errorCode ∈ { rate_limited, no_keys, upstream_error }
// - 429                    → clé mise en cooldown, on essaie la suivante
// - 401/402/403            → clé désactivée, on essaie la suivante
// - toutes les clés KO     → errorCode = rate_limited (si 429) ou no_keys

async function trebloCall(endpoint, method = "GET", body = null, timeoutMs = 30000) {
  const keys = loadKeys();
  if (!keys.length) {
    const e = new Error("Aucune clé configurée (treblo_keys.json ou TREBLO_API_KEYS)");
    e.errorCode = "no_keys";
    throw e;
  }
  let sawRateLimit = false;
  let lastErr = null;
  const tried = new Set();
  while (tried.size < keys.length) {
    const key = pickKey();
    if (!key || tried.has(key)) break;
    tried.add(key);
    try {
      const r = await fetchWithTimeout(`${TREBLO_BASE_URL}${endpoint}`, {
        method,
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      }, timeoutMs);
      if (r.status === 429) { markRateLimited(key); sawRateLimit = true; continue; }
      if (r.status === 401 || r.status === 402 || r.status === 403) { markDead(key, r.status); continue; }
      const text = await r.text();
      let data; try { data = JSON.parse(text); } catch { data = { _raw: text.slice(0, 200) }; }
      if (!r.ok) {
        // Toute autre erreur amont (400 « clé invalide », 5xx…) → clé suivante.
        // Observation 2026-09-07 : l'amont répond 400 (et non 401) pour une clé
        // invalide — on tourne donc sur TOUTES les erreurs pour ne jamais
        // bloquer sur une mauvaise clé. Détail réservé au journal serveur.
        logUpstream("treblo", `HTTP ${r.status} ${endpoint} ${text.slice(0, 300)}`);
        lastErr = new Error(`HTTP ${r.status}`);
        lastErr.errorCode = "upstream_error";
        continue;
      }
      return data;
    } catch (err) {
      if (err.name === "AbortError") {
        logUpstream("treblo", `timeout ${endpoint}`);
        lastErr = err; lastErr.errorCode = lastErr.errorCode || "upstream_error";
        continue;
      }
      if (err.errorCode === "rate_limited" || err.errorCode === "no_keys") { lastErr = err; continue; }
      lastErr = err; // réseau : clé suivante
      continue;
    }
  }
  if (sawRateLimit) { const e = new Error("Toutes les clés sont en limite de débit"); e.errorCode = "rate_limited"; throw e; }
  const e = new Error(lastErr?.message || "Aucune clé disponible");
  e.errorCode = lastErr?.errorCode || "no_keys";
  throw e;
}

// ─── Mapping payload APK → corps Treblo ──────────────────────────────────────
// Format NOUVEAU : { prompt, lyrics, duration, instrumental, title, ... }
// Format ANCIEN   : { messages: [{ role:'user', content:'<prompt>…</prompt>\n<lyrics>…</lyrics>' }] }
// Treblo recommande : envoyer prompt (+ lyrics) et laisser le modèle inférer
// les tags. `length_range` : multiples de 30, min 0–270, max 30–300.

function parseLegacyMessages(payload) {
  try {
    const content = payload?.messages?.[0]?.content;
    if (typeof content !== "string") return null;
    const prompt = (content.match(/<prompt>([\s\S]*?)<\/prompt>/) || [])[1] || "";
    const lyrics = (content.match(/<lyrics>([\s\S]*?)<\/lyrics>/) || [])[1] || "";
    if (!prompt && !lyrics) return { prompt: content.trim(), lyrics: "" };
    return { prompt: prompt.trim(), lyrics: lyrics.trim() };
  } catch { return null; }
}

function round30(n) { return Math.round(n / 30) * 30; }

function buildTrebloBody(payload) {
  const legacy = parseLegacyMessages(payload);
  const prompt = String(payload.prompt || legacy?.prompt || "").trim();
  const lyrics = String(payload.lyrics || legacy?.lyrics || "").trim();
  const instrumental = payload.instrumental === true;

  if (!prompt && !lyrics && !payload.tags?.length) {
    const e = new Error("prompt ou lyrics requis");
    e.errorCode = "bad_request";
    throw e;
  }

  const body = { output_format: "mp3", instrumental };
  if (prompt) body.prompt = prompt;
  if (lyrics && !instrumental) body.lyrics = lyrics;
  if (Array.isArray(payload.tags) && payload.tags.length > 0) body.tags = payload.tags.slice(0, 10);

  // Durée souhaitée → plage [min, max] en multiples de 30 (bornes Treblo)
  const duration = parseInt(payload.duration, 10);
  if (!instrumental && Number.isFinite(duration) && duration > 0) {
    const target = Math.min(300, Math.max(30, round30(duration)));
    const lo = Math.max(0, Math.min(270, target - 30));
    const hi = Math.max(30, Math.min(300, target + 30));
    body.length_range = [lo, hi];
  }
  return body;
}

// ─── Génération Treblo (arrière-plan) ────────────────────────────────────────

function isTerminalUpstream(s) { return s === "SUCCESS" || s === "FAILURE"; }

async function downloadToBuffer(url) {
  const r = await fetchWithTimeout(url, {}, 60000);
  if (!r.ok) throw new Error(`download HTTP ${r.status}`);
  const ab = await r.arrayBuffer();
  return Buffer.from(ab);
}

async function persistAudio(localId, buffer) {
  storeAudio(localId, buffer);
  if (USE_S3 && s3) {
    try {
      await s3.putObject({
        Bucket: process.env.AWS_S3_BUCKET,
        Key: `music/${localId}.mp3`,
        Body: buffer,
        ContentType: "audio/mpeg",
      }).promise();
    } catch (err) { logUpstream("s3", err); }
  }
  if (AUTO_DOWNLOAD) {
    try { fs.writeFileSync(path.join(OUTPUT_DIR, `${localId}.mp3`), buffer); }
    catch (err) { logUpstream("disk", err); }
  }
}

// ─── Lecture du statut amont ─────────────────────────────────────────────────
// OBSERVATION EN PRODUCTION (2026-09-07, clé réelle) :
//   GET /generations/status/{id} renvoie une CHAÎNE JSON brute ("GENERATING",
//   "SUCCESS", "FAILURE") — pas un objet. GET /generations/{id} renvoie
//   l'objet complet et c'est LÀ que se trouvent les song_paths.
function upstreamStatusOf(data) {
  if (typeof data === "string") return data.trim().toUpperCase();
  if (data && typeof data === "object" && typeof data.status === "string") return data.status.trim().toUpperCase();
  return "";
}

async function fetchSongPaths(upstreamId) {
  const info = await trebloCall(`/generations/${encodeURIComponent(upstreamId)}`, "GET", null, 20000);
  const paths = Array.isArray(info?.song_paths) ? info.song_paths : [];
  if (!paths.length) return null;
  return typeof paths[0] === "string" ? paths[0] : paths[0]?.url || null;
}

async function runTrebloPolling(localId) {
  const entry = taskStore.get(localId);
  if (!entry || !entry.upstreamId) return;
  try {
    // Poll du statut amont (chaîne brute) puis détail (/generations/{id})
    // pour obtenir les song_paths — le statut ne les renvoie JAMAIS.
    for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
      await new Promise(r => setTimeout(r, i === 0 ? 3000 : Math.min(POLL_BASE_DELAY_MS * (1 + 0.15 * i), 20000)));
      let data;
      try { data = await trebloCall(`/generations/status/${encodeURIComponent(entry.upstreamId)}`, "GET", null, 20000); }
      catch (err) {
        if (err.errorCode === "rate_limited") { entry.phase = "error"; entry.errorCode = "rate_limited"; return; }
        continue; // glitch réseau → on continue à poller
      }
      const st = upstreamStatusOf(data);
      if (st === "SUCCESS") {
        let url = null;
        try { url = await fetchSongPaths(entry.upstreamId); }
        catch (err) { logUpstream("treblo-detail", err); }
        if (!url) { entry.phase = "error"; entry.errorCode = "upstream_failed"; return; }
        entry.songPath = url;
        try {
          const buffer = await downloadToBuffer(url);
          await persistAudio(localId, buffer);
        } catch (err) {
          // pas grave : /download retentera le CDN en direct (entry.songPath)
          logUpstream("prefetch", err);
        }
        entry.phase = "ready";
        console.log(`[task] ${localId} prête (${Math.round((Date.now() - entry.createdAt) / 1000)}s)`);
        return;
      }
      if (st === "FAILURE") {
        logUpstream("treblo", `FAILURE ${entry.upstreamId}`);
        entry.phase = "error"; entry.errorCode = "upstream_failed";
        return;
      }
    }
    entry.phase = "error"; entry.errorCode = "timeout";
  } catch (err) {
    entry.phase = "error";
    entry.errorCode = err.errorCode || "upstream_error";
    logUpstream("treblo-poll", err);
  }
}

// ─── Moteur secondaire optionnel (engineB) ───────────────────────────────────
// Activable uniquement par variables d'environnement. Les messages restent
// neutres : aucun nom ni détail amont ne sort vers le client.

async function runEngineBGeneration(localId, payload) {
  const entry = taskStore.get(localId);
  if (!entry || !ENABLE_ENGINEB || !ENGINEB_BASE_URL) return;
  try {
    const ctrlTimeout = 9 * 60 * 1000;
    const headers = { "Content-Type": "application/json" };
    if (ENGINEB_API_KEY) headers["Authorization"] = `Bearer ${ENGINEB_API_KEY}`;
    const r = await fetchWithTimeout(`${ENGINEB_BASE_URL}/v1/chat/completions`, {
      method: "POST", headers, body: JSON.stringify(payload),
    }, ctrlTimeout);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { entry.phase = "error"; entry.errorCode = "upstream_failed"; logUpstream("engineB", `HTTP ${r.status}`); return; }
    const msg = data?.choices?.[0]?.message;
    const audioArr = msg?.audio || (msg?.audio_url ? [{ audio_url: msg.audio_url }] : null);
    const url = audioArr?.[0]?.audio_url?.url;
    if (!url) { entry.phase = "error"; entry.errorCode = "upstream_failed"; logUpstream("engineB", "pas d'audio"); return; }
    try { await persistAudio(localId, await downloadToBuffer(url)); }
    catch (err) { logUpstream("engineB-prefetch", err); }
    entry.songPath = url;
    entry.phase = "ready";
  } catch (err) {
    entry.phase = "error";
    entry.errorCode = err.name === "AbortError" ? "timeout" : "upstream_failed";
    logUpstream("engineB", err);
  }
}

// ─── Handlers ────────────────────────────────────────────────────────────────

async function handleGenerate(req, res) {
  const ip = getClientIP(req);

  if (CLIENT_API_KEY) {
    const key = req.headers["x-client-key"] || req.headers["x-api-key"];
    if (!key || key !== CLIENT_API_KEY) return jsonRes(res, 401, { status: "ERROR", error_code: "unauthorized", message: "Unauthorized" });
  }
  if (!checkRateLimit(ip)) {
    return jsonRes(res, 429, { status: "ERROR", error_code: "rate_limited", message: NEUTRAL_ERRORS.rate_limited.message });
  }

  let payload;
  try { payload = await parseBody(req); }
  catch (e) { return jsonRes(res, 400, { status: "ERROR", error_code: "bad_request", message: e.message }); }

  const localId = newLocalId();
  const title = String(payload.title || "Génération MC IA").slice(0, 120);

  // ── Moteur secondaire (explicitement demandé ET activé) ──
  if (payload.engine === "engineb" && ENABLE_ENGINEB && ENGINEB_BASE_URL) {
    taskStore.set(localId, { engine: "engineb", upstreamId: null, phase: "processing", errorCode: null, songPath: null, title, createdAt: Date.now() });
    incrementRate(ip);
    jsonRes(res, 200, { status: "SUBMITTED", taskId: localId });
    runEngineBGeneration(localId, payload);
    return;
  }

  // ── Treblo (moteur principal) ──
  let trebloBody;
  try { trebloBody = buildTrebloBody(payload); }
  catch (e) {
    const ne = neutralError(e.errorCode || "bad_request");
    return jsonRes(res, ne.status, ne.body);
  }

  // Pas de clé configurée du tout → échec immédiat et honnête
  if (!loadKeys().length) {
    const ne = neutralError("no_keys");
    return jsonRes(res, ne.status, ne.body);
  }

  // Soumission SYNCHRONE (rapide, ~1-2s) : la rotation de clés se fait ICI,
  // donc un 429 sur toutes les clés est signalé immédiatement au client
  // (pas de faux "Traitement…"). Seul le POLL part en arrière-plan.
  let upstreamId;
  try {
    const sub = await trebloCall(`/generations/${TREBLO_MODEL}`, "POST", trebloBody, 45000);
    upstreamId = sub?.task_id || sub?.id;
    if (!upstreamId) {
      logUpstream("treblo-submit", "pas de task_id dans la réponse");
      const ne = neutralError("upstream_error");
      return jsonRes(res, ne.status, ne.body);
    }
  } catch (err) {
    logUpstream("treblo-submit", err);
    const code = (err.errorCode === "bad_request") ? "bad_request" : (err.errorCode || "upstream_error");
    const ne = neutralError(code);
    return jsonRes(res, ne.status, ne.body);
  }

  taskStore.set(localId, { engine: "treblo", upstreamId, phase: "processing", errorCode: null, songPath: null, title, createdAt: Date.now() });
  incrementRate(ip);
  jsonRes(res, 200, { status: "SUBMITTED", taskId: localId });
  runTrebloPolling(localId);
}

async function handleStatus(req, res, localId) {
  // 1. TOUJOURS le store local d'abord (correctif bug uuid_parsing)
  const entry = taskStore.get(localId);
  if (!entry) {
    // Tâche inconnue (redémarrage du conteneur, ID ancien format…) :
    // réponse tolérante pour ne pas casser un ancien client en cours de poll.
    return jsonRes(res, 200, { status: "PROCESSING" });
  }

  if (entry.phase === "error") {
    const code = entry.errorCode || "upstream_failed";
    // 'upstream_failed' et 'timeout' sont renvoyés en 200 pour que l'APK
    // affiche son écran d'échec habituel (contrat historique).
    return jsonRes(res, 200, {
      status: "FAILURE",
      error_code: code,
      error_message: NEUTRAL_ERRORS[code]?.message || NEUTRAL_ERRORS.upstream_failed.message,
    });
  }
  if (entry.phase === "ready") {
    return jsonRes(res, 200, { status: "SUCCESS", song_paths: [`/download/${encodeURIComponent(localId)}`] });
  }

  // 2. Moteur secondaire : tout passe par le store (géré plus haut).
  if (entry.engine !== "treblo") return jsonRes(res, 200, { status: "PROCESSING" });

  // 3. Treblo : si l'upstreamId n'est pas encore connu → toujours en cours
  if (!entry.upstreamId) return jsonRes(res, 200, { status: "PROCESSING" });

  // 4. Relais du statut amont (au cas où le poll d'arrière-plan a été perdu
  //    après un redémarrage) — mais c'est le store qui fait foi.
  try {
    const data = await trebloCall(`/generations/status/${encodeURIComponent(entry.upstreamId)}`, "GET", null, 15000);
    const st = upstreamStatusOf(data);
    if (st === "SUCCESS") {
      let url = entry.songPath || null;
      if (!url) { try { url = await fetchSongPaths(entry.upstreamId); } catch { url = null; } }
      if (url) {
        entry.songPath = url;
        entry.phase = "ready";
        if (!audioStore.has(localId)) {
          downloadToBuffer(url).then(b => persistAudio(localId, b)).catch(() => {});
        }
        return jsonRes(res, 200, { status: "SUCCESS", song_paths: [`/download/${encodeURIComponent(localId)}`] });
      }
    }
    if (st === "FAILURE") {
      entry.phase = "error"; entry.errorCode = "upstream_failed";
      return jsonRes(res, 200, { status: "FAILURE", error_code: "upstream_failed", error_message: NEUTRAL_ERRORS.upstream_failed.message });
    }
    return jsonRes(res, 200, { status: "PROCESSING" });
  } catch (err) {
    if (err.errorCode === "rate_limited") {
      return jsonRes(res, 200, { status: "PROCESSING" }); // cooldown des clés : on garde "en cours"
    }
    return jsonRes(res, 200, { status: "PROCESSING" });
  }
}

async function handleDownloadById(res, localId) {
  // 1. Mémoire
  const audio = audioStore.get(localId);
  if (audio?.buffer) {
    res.writeHead(200, {
      "Content-Type": "audio/mpeg",
      "Content-Disposition": `attachment; filename="${localId}.mp3"`,
      "Content-Length": audio.buffer.length,
    });
    return res.end(audio.buffer);
  }

  // 2. S3
  if (USE_S3 && s3) {
    try {
      const obj = await s3.getObject({ Bucket: process.env.AWS_S3_BUCKET, Key: `music/${localId}.mp3` }).promise();
      res.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Disposition": `attachment; filename="${localId}.mp3"` });
      return res.end(obj.Body);
    } catch { /* suite */ }
  }

  // 3. Disque
  if (AUTO_DOWNLOAD) {
    const filePath = path.join(OUTPUT_DIR, `${localId}.mp3`);
    if (fs.existsSync(filePath)) {
      res.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Disposition": `attachment; filename="${localId}.mp3"` });
      return fs.createReadStream(filePath).pipe(res);
    }
  }

  // 4. CDN amont en direct (URLs éphémères — stockées au moment du SUCCESS)
  const entry = taskStore.get(localId);
  if (entry?.songPath) {
    try {
      const r = await fetchWithTimeout(entry.songPath, {}, 60000);
      if (r.ok) {
        res.writeHead(200, { "Content-Type": r.headers.get("content-type") || "audio/mpeg", "Content-Disposition": `attachment; filename="${localId}.mp3"` });
        return streamPipeline(r.body, res);
      }
    } catch (err) { logUpstream("download-cdn", err); }
  }

  const ne = neutralError("expired");
  jsonRes(res, ne.status, ne.body);
}

async function handleDownloadProxy(res, trackUrl) {
  if (!trackUrl) return jsonRes(res, 400, { status: "ERROR", error_code: "bad_request", message: "Missing url" });
  let host = "";
  try { host = new URL(trackUrl).hostname.toLowerCase(); } catch { return jsonRes(res, 400, { status: "ERROR", error_code: "bad_request", message: "Invalid url" }); }
  if (!DOWNLOAD_ALLOWLIST.some(h => host === h || host.endsWith("." + h))) {
    return jsonRes(res, 400, { status: "ERROR", error_code: "bad_request", message: "URL not allowed" });
  }
  try {
    const r = await fetchWithTimeout(trackUrl, {}, 60000);
    if (!r.ok) { const ne = neutralError("expired"); return jsonRes(res, ne.status, ne.body); }
    res.writeHead(200, { "Content-Type": r.headers.get("content-type") || "audio/mpeg", "Content-Disposition": 'attachment; filename="track.mp3"' });
    await streamPipeline(r.body, res);
  } catch (err) {
    const ne = neutralError("upstream_error");
    jsonRes(res, ne.status, ne.body);
  }
}

// ─── Serveur HTTP ────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const { pathname, query } = urlModule.parse(req.url, true);

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-CLIENT-KEY, Authorization");

  if (req.method === "OPTIONS") { res.writeHead(200); res.end(); return; }

  if (pathname === "/health" && req.method === "GET") {
    return jsonRes(res, 200, {
      status: "ok",
      service: "Music AI Proxy",
      version: "2.1-treblo",
      authRequired: !!CLIENT_API_KEY,
      keys: { total: loadKeys().length, active: activeKeys().length },
      tasks: { tracked: taskStore.size, audioCached: audioStore.size },
      engineb: ENABLE_ENGINEB && !!ENGINEB_BASE_URL,
    });
  }

  const htmlPath = path.join(__dirname, "public", "index.html");
  if ((pathname === "/" || pathname === "/ui") && req.method === "GET" && fs.existsSync(htmlPath)) {
    res.writeHead(200, { "Content-Type": "text/html" });
    return res.end(fs.readFileSync(htmlPath, "utf-8"));
  }

  try {
    if (pathname === "/generate"          && req.method === "POST") return await handleGenerate(req, res);
    if (pathname.startsWith("/status/")   && req.method === "GET")  return await handleStatus(req, res, decodeURIComponent(pathname.split("/")[2] || ""));
    if (pathname.startsWith("/download/") && req.method === "GET")  return await handleDownloadById(res, decodeURIComponent(pathname.split("/")[2] || ""));
    if (pathname === "/download"          && req.method === "GET")  return await handleDownloadProxy(res, query.url);
  } catch (err) {
    console.error("[proxy] erreur non gérée:", err);
    const ne = neutralError("upstream_error");
    return jsonRes(res, 500, ne.body);
  }

  jsonRes(res, 404, { status: "ERROR", error_code: "not_found", message: "Not found" });
});

server.listen(PORT, () => {
  console.log(`[proxy] Music AI Proxy v2 (Treblo ${TREBLO_MODEL}) · port ${PORT} · clés: ${loadKeys().length} (actives: ${activeKeys().length}) · S3=${USE_S3} · disque=${AUTO_DOWNLOAD} · dailyLimit=${DAILY_LIMIT} · engineB=${ENABLE_ENGINEB && !!ENGINEB_BASE_URL}`);
});

// ─── Keep-alive ──────────────────────────────────────────────────────────────

const KEEP_ALIVE_URL      = process.env.KEEP_ALIVE_URL || null;
const KEEP_ALIVE_INTERVAL = parseInt(process.env.KEEP_ALIVE_INTERVAL_MS) || 4 * 60 * 1000;

if (KEEP_ALIVE_URL) {
  const ping = async () => {
    try { await fetchWithTimeout(KEEP_ALIVE_URL, {}, 8000); } catch { /* silencieux */ }
  };
  ping();
  setInterval(ping, KEEP_ALIVE_INTERVAL);
  process.on("SIGINT",  () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
}
