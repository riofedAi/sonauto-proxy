/**
 * server.js — Music AI Proxy · PATCH GÉNÉRATION MUSICALE 2026-08-30 (v2)
 * Engines: ACE-Step (nouvelle API v2 acestep.io) + Sonauto (fallback transparent)
 * + Forwarding MCIA/PythonAnywhere INTÉGRÉ (ex-mcia_service.js v3.2) →
 *   DROP-IN REPLACEMENT strict de la version déployée « Undici-KeepAlive » :
 *   mêmes routes, mêmes variables d'env, même comportement pour /mcia, /hymns,
 *   /programmes, /glorias, /jic, /updates, /login (forwarding + fallback Kimi).
 * Node.js 18+
 *
 * ⚠ CONTEXTE DU PATCH (pourquoi cette version existe) :
 *   L'ancienne API cloud ACE-Step (api.acemusic.ai) est MORTE depuis mai 2026
 *   (GitHub issue ace-step/ACE-Step-1.5#1186). Elle renvoie du HTML au lieu de
 *   JSON → le proxy échouait avec "Unexpected token < in JSON at position 0"
 *   → toute génération musicale déclenchée par un tool call MC IA plantait
 *   (l'utilisateur ne voyait que le message générique côté APK).
 *
 *   NOUVELLE chaîne pour les tâches `acestep-*` (contrat APK STRICTEMENT
 *   identique — aucun changement côté application) :
 *     1. ACE-Step v2 (https://acestep.io/api/v2) — si ACESTEP_V2_API_KEY fournie
 *     2. Sinon/échec → FALLBACK AUTOMATIQUE Sonauto (marche aujourd'hui)
 *        → le MP3 est stocké EN MÉMOIRE sous le MÊME taskId `acestep-...`
 *        → /status renvoie SUCCESS + song_paths[/download/{taskId}] comme avant
 *     3. Si tout échoue → storeError avec la VRAIE erreur diagnostique
 *        (plus jamais "Unexpected token <" — messages explicites + logs horodatés)
 *
 * Storage strategy:
 *   - Audio stored in-memory (Map) — no disk dependency
 *   - Optional S3 for persistence across restarts (AWS_S3_BUCKET + credentials)
 *   - AUTO_DOWNLOAD=false recommended on Render (ephemeral disk)
 *
 * Security:
 *   - Daily rate limit: 8 generations / IP / day (inchangé)
 *   - Max body size: 25 MB
 *   - Audio validation: base64 size check, format check
 *
 * Env variables:
 *   EXPO_PUBLIC_SONAUTO_API_KEY   — Sonauto API key (REQUISE pour le fallback)
 *   ACESTEP_V2_API_KEY            — NOUVEAU : clé API acestep.io (optionnelle —
 *                                    abonnement Studio requis pour la créer)
 *   ACESTEP_V2_BASE_URL           — default: https://acestep.io
 *   ACESTEP_API_KEY               — (legacy, ignoré si V2 absente) conservé pour compat
 *   ACESTEP_BASE_URL              — (legacy, mort) ignoré — voir PATCH notes
 *   CLIENT_API_KEY                — optional: protect /generate (X-CLIENT-KEY header)
 *   PYTHONANYWHERE_BASE_URL       — optional: forwarding /mcia,/hymns,/login,... vers
 *                                   PythonAnywhere (ex-mcia_service.js, même nom d'env)
 *   NVIDIA_API_URL / NVIDIA_API_KEY — optional: fallback LLM Kimi pour /mcia/chat
 *                                   quand PythonAnywhere est hors-ligne
 *   PORT                          — default: 3000
 *   KEEP_ALIVE_URL                — public URL for self-ping (prevents Render sleep)
 *   KEEP_ALIVE_INTERVAL_MS        — default: 240000 (4 min)
 *   AUTO_DOWNLOAD                 — save tracks to disk (default: false)
 *   AWS_S3_BUCKET / AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION — optional
 *   IN_MEMORY_TTL_MS              — how long to keep audio in memory (default: 30 min)
 *   DAILY_LIMIT                   — max generations per IP per day (default: 8)
 *   MAX_BODY_SIZE_MB              — max JSON body size in MB (default: 25)
 */

require("dotenv").config();

const http          = require("http");
const fs            = require("fs");
const path          = require("path");
const urlModule     = require("url");
const { pipeline }  = require("stream");
const { promisify } = require("util");
const streamPipeline = promisify(pipeline);

// ─── Keep-alive global (parité « Undici-KeepAlive ») ────────────────────────

let undiciFetch = null; // fetch undici (supporte l'option dispatcher)
try {
  const undici = require("undici");
  const { Agent, setGlobalDispatcher } = undici;
  setGlobalDispatcher(new Agent({
    connections: 25,
    keepAliveTimeout: 60000,
    keepAliveMaxTimeout: 300000,
  }));
  undiciFetch = undici.fetch;
} catch { /* undici absent — le fetch natif Node 18+ garde déjà les connexions */ }

// ─── Config ──────────────────────────────────────────────────────────────────

const PORT              = process.env.PORT || 3000;
const SONAUTO_API_KEY   = process.env.EXPO_PUBLIC_SONAUTO_API_KEY;
const ACESTEP_V2_API_KEY  = process.env.ACESTEP_V2_API_KEY || "";
const ACESTEP_V2_BASE_URL = (process.env.ACESTEP_V2_BASE_URL || "https://acestep.io").replace(/\/+$/, "");
const SONAUTO_BASE_URL  = process.env.SONAUTO_BASE_URL_OVERRIDE || "https://api.sonauto.ai/v1";
const CLIENT_API_KEY    = process.env.CLIENT_API_KEY || null;
const AUTO_DOWNLOAD     = process.env.AUTO_DOWNLOAD === "true";
const IN_MEMORY_TTL     = parseInt(process.env.IN_MEMORY_TTL_MS) || 30 * 60 * 1000; // 30 min
const DAILY_LIMIT       = parseInt(process.env.DAILY_LIMIT) || 8;
const MAX_BODY_SIZE     = (parseInt(process.env.MAX_BODY_SIZE_MB) || 25) * 1024 * 1024; // 25 MB
const MAX_AUDIO_BASE64  = 15 * 1024 * 1024; // ~15 MB base64 (~10 MB raw audio)

// Budgets de polling (l'APK ne poll que 3 min → on doit être rapide)
const V2_POLL_INTERVAL_MS   = 3000;
const V2_POLL_MAX_MS        = 150000;  // 150 s max sur ACE-Step v2 avant bascule Sonauto
const SONAUTO_POLL_INTERVAL = 4000;
const SONAUTO_POLL_MAX_ATTEMPTS = 60;  // 60 × 4 s = 240 s (l'APK suit 180 s)

function logi(...args) { console.log(new Date().toISOString(), "[proxy]", ...args); }
function loge(...args) { console.error(new Date().toISOString(), "[proxy][ERREUR]", ...args); }

// ─── In-memory store ─────────────────────────────────────────────────────────

const audioStore = new Map(); // taskId → { buffer } | { error } | { processing: true, engine }

function storeAudio(taskId, buffer) {
  audioStore.set(taskId, { buffer, expiresAt: Date.now() + IN_MEMORY_TTL });
  setTimeout(() => audioStore.delete(taskId), IN_MEMORY_TTL);
}

function storeError(taskId, message) {
  audioStore.set(taskId, { error: String(message), expiresAt: Date.now() + IN_MEMORY_TTL });
  setTimeout(() => audioStore.delete(taskId), IN_MEMORY_TTL);
}

// ─── Rate limiter (per IP, daily) ────────────────────────────────────────────

const rateMap = new Map(); // IP → { date: "YYYY-MM-DD", count: N }

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
  if (!entry || entry.date !== today) {
    rateMap.set(ip, { date: today, count: 0 });
    return true;
  }
  return entry.count < DAILY_LIMIT;
}

function incrementRate(ip) {
  const today = getToday();
  const entry = rateMap.get(ip);
  if (!entry || entry.date !== today) {
    rateMap.set(ip, { date: today, count: 1 });
  } else {
    rateMap.set(ip, { date: today, count: entry.count + 1 });
  }
}

setInterval(() => {
  const today = getToday();
  for (const [ip, entry] of rateMap) {
    if (entry.date !== today) rateMap.delete(ip);
  }
}, 3600000);

// ─── Optional disk output (AUTO_DOWNLOAD=true only) ───────────────────────────

const OUTPUT_DIR = path.join(__dirname, "songs");
if (AUTO_DOWNLOAD && !fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// ─── Optional S3 ─────────────────────────────────────────────────────────────

let s3 = null;
const USE_S3 = !!(process.env.AWS_S3_BUCKET && process.env.AWS_ACCESS_KEY_ID);
if (USE_S3) {
  try {
    const AWS = require("aws-sdk");
    AWS.config.update({ region: process.env.AWS_REGION || "us-east-1" });
    s3 = new AWS.S3();
  } catch {
    console.warn("[proxy] aws-sdk not found — S3 disabled");
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

async function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    let total = 0;
    req.on("data", c => {
      total += c.length;
      if (total > MAX_BODY_SIZE) {
        req.destroy();
        return reject(new Error("Payload too large — max " + (MAX_BODY_SIZE / 1024 / 1024) + " MB"));
      }
      raw += c;
    });
    req.on("end", () => {
      try { resolve(JSON.parse(raw || "{}")); }
      catch (e) { reject(new Error("Invalid JSON body")); }
    });
    req.on("error", reject);
  });
}

/**
 * Fetch JSON robuste — PATCH 2026-08-30 :
 * détecte les réponses HTML / non-JSON (l'erreur "Unexpected token <" historique)
 * et renvoie une erreur EXPLICITE avec le statut HTTP upstream.
 */
async function fetchJson(url, opts = {}, timeoutMs = 60000) {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await r.text();
    let data = null;
    const trimmed = (text || "").trim();
    const looksHtml = trimmed.startsWith("<") || /<html|<!doctype/i.test(trimmed.slice(0, 200));
    if (looksHtml) {
      const err = new Error(`upstream HTTP ${r.status} a renvoyé du HTML au lieu de JSON (endpoint mort ou bloqué Cloudflare)`);
      err.status = r.status;
      err.upstreamHtml = true;
      throw err;
    }
    try { data = trimmed ? JSON.parse(trimmed) : null; }
    catch (e) {
      const err = new Error(`upstream HTTP ${r.status} a renvoyé du non-JSON: ${trimmed.slice(0, 120)}`);
      err.status = r.status;
      throw err;
    }
    if (!r.ok) {
      const err = new Error(`upstream HTTP ${r.status}: ${typeof data === "object" ? JSON.stringify(data).slice(0, 300) : trimmed.slice(0, 300)}`);
      err.status = r.status;
      err.data = data;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(tid);
  }
}

async function downloadBuffer(url, headers = {}, timeoutMs = 120000) {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers, signal: ctrl.signal });
    if (!r.ok) throw new Error(`téléchargement audio HTTP ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  } finally {
    clearTimeout(tid);
  }
}

function jsonRes(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function isSonautoHost(trackUrl) {
  try { return new URL(trackUrl).hostname.includes("sonauto.ai"); }
  catch { return false; }
}

// ─── Audio validation (modes avec audio source — inchangé) ───────────────────

function validateAudioSource(payload) {
  const m = payload.mode;
  const needsAudio = ["remix", "repaint", "retake", "lego", "complete"].includes(m);
  if (!needsAudio) return null;

  const msgs = payload.messages || [];
  let hasAudio = false;
  let audioData = null;

  for (const msg of msgs) {
    const content = msg.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part.type === "input_audio" && part.input_audio?.data) {
          hasAudio = true;
          audioData = part.input_audio.data;
        }
      }
    }
  }

  if (!hasAudio) return "Mode '" + m + "' requires an audio source file.";

  if (audioData && audioData.length > MAX_AUDIO_BASE64) {
    return "Audio file too large. Maximum 90 seconds of audio.";
  }

  const fmt = (msgs[0]?.content?.find?.(p => p.input_audio?.format)?.input_audio?.format || "").toLowerCase();
  if (fmt && !["mp3", "wav", "flac", "m4a", "ogg"].includes(fmt)) {
    return "Unsupported audio format: " + fmt + ". Use MP3, WAV, or FLAC.";
  }

  return null;
}

// ─── Sonauto API call ─────────────────────────────────────────────────────────

async function sonautoCall(endpoint, method = "GET", body = null) {
  if (!SONAUTO_API_KEY) throw new Error("Missing EXPO_PUBLIC_SONAUTO_API_KEY (clé Sonauto non configurée sur le proxy)");
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${SONAUTO_API_KEY}`,
      "Content-Type": "application/json",
    },
  };
  if (body) opts.body = JSON.stringify(body);
  return fetchJson(`${SONAUTO_BASE_URL}${endpoint}`, opts, 60000);
}

// ─── Extraction prompt/lyrics depuis le payload APK ───────────────────────────
// L'APK envoie messages:[{role:"user", content:"<prompt>...style: X...</prompt>\n<lyrics>...</lyrics>"}]

function extractPromptAndLyrics(payload) {
  let text = "";
  if (payload.lyrics || payload.prompt) {
    text = (payload.prompt ? `<prompt>${payload.prompt}</prompt>\n` : "") + (payload.lyrics ? `<lyrics>${payload.lyrics}</lyrics>` : "");
  } else {
    const msg = (payload.messages || []).find(m => m.role === "user");
    text = typeof msg?.content === "string" ? msg.content : "";
  }
  const promptMatch  = text.match(/<prompt>([\s\S]*?)<\/prompt>/i);
  const lyricsMatch  = text.match(/<lyrics>([\s\S]*?)<\/lyrics>/i);
  return {
    prompt: promptMatch ? promptMatch[1].trim() : "",
    lyrics: lyricsMatch ? lyricsMatch[1].trim() : "",
    full:   text.trim(),
  };
}

// Tags Sonauto/ACE-Step extraits du prompt APK ("...style: gospel choir, powerful harmonies...")
const TAG_WHITELISH = /^[a-zA-Z0-9 ,\-_'&()]+$/;
function extractStyleTags(payload) {
  const { prompt, full } = extractPromptAndLyrics(payload);
  let style = "";
  const m = (prompt || full).match(/style\s*:\s*([^.]+)/i);
  if (m) style = m[1].trim();
  if (!style) style = "gospel, worship, uplifting";
  // Nettoyage : garde-fou simple (limite longueur, caractères exotiques)
  style = style.replace(/\s+/g, " ").slice(0, 160);
  if (!TAG_WHITELISH.test(style)) style = style.replace(/[^a-zA-Z0-9 ,\-_'&()]/g, "").trim();
  if (!style) style = "gospel, worship, uplifting";
  return style;
}

// ─── ACE-Step v2 (nouvelle API officielle acestep.io) ─────────────────────────
// POST /api/v2/generate-audio {tags, lyrics, seconds, steps, studio_quality}
//   → {code:0, data:{tasks:[{task_id},...]}}
// GET  /api/v2/task-status/{id}
//   → {code:0, data:{status:"queued|submitted|running|processing|completed|failed",
//                     progress, message, audio_url, lrc}}

async function acestepV2Submit(payload) {
  if (!ACESTEP_V2_API_KEY) throw new Error("ACESTEP_V2_API_KEY non configurée sur le proxy (fallback Sonauto utilisé)");
  const { lyrics } = extractPromptAndLyrics(payload);
  const tags = extractStyleTags(payload);
  const body = {
    tags,
    lyrics: lyrics || "[inst]",
    seconds: payload.duration || 60,
    steps: 12,
    studio_quality: false,
  };
  if (payload.instrumental) body.lyrics = "[inst]";
  logi(`ACE-Step v2 → submit (tags="${body.tags}", seconds=${body.seconds}, lyrics=${body.lyrics ? body.lyrics.length + " chars" : "[inst]"})`);
  const resp = await fetchJson(`${ACESTEP_V2_BASE_URL}/api/v2/generate-audio`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ACESTEP_V2_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  }, 60000);
  if (resp?.code !== 0 || !resp?.data) {
    throw new Error(`ACE-Step v2 réponse inattendue: ${JSON.stringify(resp).slice(0, 300)}`);
  }
  const tasks = Array.isArray(resp.data.tasks) && resp.data.tasks.length
    ? resp.data.tasks
    : (resp.data.task_id ? [{ task_id: resp.data.task_id }] : []);
  if (!tasks.length || !tasks[0].task_id) {
    throw new Error(`ACE-Step v2: aucun task_id dans la réponse: ${JSON.stringify(resp.data).slice(0, 300)}`);
  }
  return tasks.map(t => t.task_id);
}

async function acestepV2WaitForAudio(taskIds) {
  const t0 = Date.now();
  let lastStatus = "";
  while (Date.now() - t0 < V2_POLL_MAX_MS) {
    await new Promise(r => setTimeout(r, V2_POLL_INTERVAL_MS));
    for (const taskId of taskIds) {
      const resp = await fetchJson(`${ACESTEP_V2_BASE_URL}/api/v2/task-status/${taskId}`, {
        headers: { Authorization: `Bearer ${ACESTEP_V2_API_KEY}` },
      }, 30000);
      const d = resp?.data || {};
      const status = String(d.status || "").toLowerCase();
      if (status !== lastStatus) {
        lastStatus = status;
        logi(`ACE-Step v2 ${taskId}: status=${status} progress=${d.progress ?? "?"}`);
      }
      if (status === "completed" && d.audio_url) return d.audio_url;
      if (status === "failed") throw new Error(`ACE-Step v2 tâche échouée: ${d.message || "sans message"}`);
    }
  }
  throw new Error(`ACE-Step v2 timeout (${Math.round(V2_POLL_MAX_MS / 1000)} s) — dernier status: ${lastStatus || "?"}`);
}

// ─── Sonauto submit + wait (fallback transparent) ─────────────────────────────

async function sonautoSubmitAndWait(payload) {
  const { lyrics } = extractPromptAndLyrics(payload);
  const tags = extractStyleTags(payload);
  const body = {
    lyrics: lyrics || undefined,
    tags: tags.split(",").map(t => t.trim()).filter(Boolean).slice(0, 8),
    instrumental: !!payload.instrumental,
    num_songs: 1, // 1 seule piste = plus rapide (l'APK ne suit que 3 min)
    output_format: "mp3",
    prompt_strength: payload.prompt_strength ?? 2.0,
    balance_strength: payload.balance_strength ?? 0.8,
    style_scale: payload.style_scale ?? 3.0,
  };
  if (!lyrics && !payload.instrumental) {
    // Pas de paroles fournies → mode simple (prompt uniquement)
    delete body.lyrics;
    body.prompt = extractPromptAndLyrics(payload).prompt || "A beautiful gospel song";
  }
  logi(`Sonauto fallback → submit (tags=[${body.tags}], num_songs=1, lyrics=${body.lyrics ? body.lyrics.length + " chars" : "—"})`);
  const gen = await sonautoCall("/generations/v3", "POST", body);
  const taskId = gen?.task_id || gen?.id;
  if (!taskId) throw new Error(`Sonauto: pas de task_id dans la réponse: ${JSON.stringify(gen).slice(0, 300)}`);

  const t0 = Date.now();
  for (let attempt = 0; attempt < SONAUTO_POLL_MAX_ATTEMPTS; attempt++) {
    await new Promise(r => setTimeout(r, SONAUTO_POLL_INTERVAL));
    let data;
    try {
      data = await sonautoCall(`/generations/${taskId}`, "GET");
    } catch (e) {
      logi(`Sonauto ${taskId}: glitch poll (${e.message}) — on continue`);
      continue;
    }
    const status = String(data.status || "").toLowerCase();
    if (attempt % 5 === 0) logi(`Sonauto ${taskId}: status=${status} (${Math.round((Date.now() - t0) / 1000)} s)`);
    if (status === "success") {
      const paths = data.song_paths || [];
      if (!paths.length) throw new Error("Sonauto SUCCESS sans song_paths");
      return paths[0];
    }
    if (status === "failure") throw new Error(`Sonauto tâche échouée: ${data.error_message || data.error || "sans message"}`);
  }
  throw new Error(`Sonauto timeout (${SONAUTO_POLL_MAX_ATTEMPTS * SONAUTO_POLL_INTERVAL / 1000} s)`);
}

// ─── Save audio (memory + optional S3/disk) ───────────────────────────────────

async function saveAudio(taskId, buffer) {
  // Toujours en mémoire pour /download/:taskId
  storeAudio(taskId, buffer);

  if (USE_S3 && s3) {
    await s3.putObject({
      Bucket:      process.env.AWS_S3_BUCKET,
      Key:         `acemusic/${taskId}.mp3`,
      Body:        buffer,
      ContentType: "audio/mpeg",
    }).promise();
  }

  if (AUTO_DOWNLOAD) {
    fs.writeFileSync(path.join(OUTPUT_DIR, `${taskId}.mp3`), buffer);
  }
}

// ─── Chaîne de génération ACE-Step (PATCH 2026-08-30) ─────────────────────────
//   1. ACE-Step v2 (acestep.io) si clé présente
//   2. → fallback automatique et TRANSPARENT vers Sonauto
//   Le résultat (peu importe le moteur) est stocké sous le taskId `acestep-...`
//   d'origine → contrat APK /status + /download strictement inchangé.

async function runAcestepGeneration(taskId, payload) {
  const errors = [];
  audioStore.set(taskId, { processing: true, engine: "pending", expiresAt: Date.now() + IN_MEMORY_TTL });

  // ── Essai 1 : ACE-Step v2 ──
  if (ACESTEP_V2_API_KEY) {
    try {
      const v2Ids = await acestepV2Submit(payload);
      const audioUrl = await acestepV2WaitForAudio(v2Ids);
      logi(`ACE-Step v2 ✅ audio prêt pour ${taskId}`);
      const buf = await downloadBuffer(audioUrl, {}, 120000);
      await saveAudio(taskId, buf);
      logi(`${taskId} ✅ SUCCESS via ACE-Step v2 (${Math.round(buf.length / 1024)} Ko)`);
      return;
    } catch (err) {
      const msg = `ACE-Step v2: ${err.message}`;
      errors.push(msg);
      loge(`${taskId} — ${msg} → bascule Sonauto`);
    }
  } else {
    errors.push("ACE-Step v2: clé non configurée (ACESTEP_V2_API_KEY)");
    logi(`${taskId} — pas de ACESTEP_V2_API_KEY → fallback Sonauto direct`);
  }

  // ── Essai 2 : fallback Sonauto (transparent) ──
  try {
    const songUrl = await sonautoSubmitAndWait(payload);
    const headers = isSonautoHost(songUrl) && SONAUTO_API_KEY
      ? { Authorization: `Bearer ${SONAUTO_API_KEY}` } : {};
    const buf = await downloadBuffer(songUrl, headers, 120000);
    await saveAudio(taskId, buf);
    logi(`${taskId} ✅ SUCCESS via fallback Sonauto (${Math.round(buf.length / 1024)} Ko)`);
    return;
  } catch (err) {
    const msg = `Sonauto (fallback): ${err.message}`;
    errors.push(msg);
    loge(`${taskId} — ${msg}`);
  }

  // ── Échec total : VRAIE erreur diagnostique (visible dans /status + logs) ──
  const realError = errors.join(" | ");
  storeError(taskId, realError);
  loge(`${taskId} 💥 ÉCHEC TOTAL — ${realError}`);
}

// ─── Sonauto direct (engine=sonauto — chemin historique inchangé) ─────────────

async function pollSonauto(taskId, mode) {
  // Tâche Sonauto directe : on la suit juste pour AUTO_DOWNLOAD/S3 (best-effort).
  for (let attempt = 0; attempt < SONAUTO_POLL_MAX_ATTEMPTS; attempt++) {
    try {
      const data = await sonautoCall(`/generations/${taskId}`, "GET");
      if (data.status === "SUCCESS") {
        if (AUTO_DOWNLOAD) {
          for (let i = 0; i < (data.song_paths || []).length; i++) {
            const filename = `sonauto_${mode}_${taskId}_${i + 1}.mp3`;
            try {
              const r = await fetch(data.song_paths[i]);
              if (r.ok) {
                const ws = fs.createWriteStream(path.join(OUTPUT_DIR, filename));
                await streamPipeline(r.body, ws).catch(() => {});
              }
            } catch { /* best-effort */ }
          }
        }
        return;
      }
      if (data.status === "FAILURE") return;
    } catch { /* keep polling */ }
    await new Promise(r => setTimeout(r, Math.min(4000 * Math.pow(1.2, attempt), 20000)));
  }
}

// ─── Forwarding MCIA / PythonAnywhere (port inline de mcia_service.js v3.2) ──
// La version déployée (« Undici-KeepAlive ») forwardait /mcia, /hymns,
// /programmes, /programme, /import-programmes, /glorias, /jic, /updates, /login
// vers PythonAnywhere via mcia_service.js (avec fallback LLM Kimi pour /mcia/chat
// et cache 5 min sur /mcia/chat/ping). Ce patch intègre EXACTEMENT la même
// logique (mêmes noms d'env) pour ne rien casser côté clients qui passeraient
// par le proxy pour ces routes.

const PYTHONANYWHERE_BASE = process.env.PYTHONANYWHERE_BASE_URL || null;
const NVIDIA_API_URL      = process.env.NVIDIA_API_URL || null;

if (!PYTHONANYWHERE_BASE) {
  console.warn("[mcia_service] PYTHONANYWHERE_BASE_URL non configuré — forwarding vers PythonAnywhere désactivé. Le fallback LLM sera utilisé pour /mcia/chat.");
}

let paPool = null; // pool keep-alive dédié vers PythonAnywhere
try {
  if (PYTHONANYWHERE_BASE && undiciFetch) {
    const { Pool } = require("undici");
    paPool = new Pool(new URL(PYTHONANYWHERE_BASE).origin, { connections: 15, keepAliveTimeout: 60000 });
  }
} catch { /* sans undici → fetch natif sans pool dédié */ }

const paCache = new Map();
const PA_CACHE_TTL = 1000 * 60 * 5; // 5 min

// Helper pour lire le corps brut des requêtes POST/PUT/PATCH
async function readRawBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", () => resolve(Buffer.from("")));
  });
}

// Fallback LLM (Kimi) si PythonAnywhere est hors-ligne — identique à mcia_service.js
async function callNvidiaKimi(messages) {
  if (!NVIDIA_API_URL) return "Service LLM non configuré.";
  try {
    const r = await fetch(NVIDIA_API_URL, {
      method: "POST",
      headers: { "Authorization": `Bearer ${process.env.NVIDIA_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "moonshotai/kimi-k2.6", messages, temperature: 0.7 }),
    });
    const data = await r.json().catch(() => ({}));
    return data?.choices?.[0]?.message?.content || data?.message || "Service momentanément indisponible.";
  } catch { return "Erreur de connexion LLM."; }
}

// Forwarder vers PythonAnywhere (timeout 60 s, Authorization pass-through)
async function forwardToPA(pathWithQuery, method, req, timeoutMs = 60000) {
  if (!PYTHONANYWHERE_BASE) throw new Error("PYTHONANYWHERE_BASE_URL non configuré");
  const url = PYTHONANYWHERE_BASE + pathWithQuery;
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const body = ["POST", "PUT", "PATCH"].includes(method) ? await readRawBody(req) : null;
    const doFetch = undiciFetch || fetch;
    const r = await doFetch(url, {
      method,
      body,
      ...(paPool ? { dispatcher: paPool } : {}),
      signal: ctrl.signal,
      headers: {
        "Content-Type":   "application/json",
        "Authorization":  req.headers["authorization"] || "",
        "Connection":     "keep-alive",
      },
    });
    const text = await r.text();
    clearTimeout(tid);
    return { status: r.status, data: text };
  } catch (e) {
    clearTimeout(tid);
    throw e;
  }
}

// Router des routes PythonAnywhere — comportement identique à mcia_service.js
async function handleMciaRoutes(req, res, pathname) {
  const qs = req.url.includes("?") ? "?" + req.url.split("?").slice(1).join("?") : "";

  // Cas A : Chat avec fallback Kimi
  if (pathname === "/mcia/chat" && req.method === "POST") {
    const rawBody = await readRawBody(req);
    try {
      if (PYTHONANYWHERE_BASE) {
        const doFetch = undiciFetch || fetch;
        const paRes = await doFetch(PYTHONANYWHERE_BASE + pathname, {
          method: "POST", body: rawBody,
          ...(paPool ? { dispatcher: paPool } : {}),
          headers: { "Content-Type": "application/json", "Authorization": req.headers["authorization"] || "" },
        });
        if (paRes.ok) {
          res.writeHead(paRes.status, { "Content-Type": paRes.headers.get("content-type") || "application/json" });
          return res.end(await paRes.text());
        }
        // si PA répond mais pas OK → fallback
      }
    } catch (e) {
      console.warn("[mcia_service] forward to PA failed:", e && e.message ? e.message : e);
    }
    let body = {};
    try { body = JSON.parse(rawBody.toString() || "{}"); } catch {}
    const messages = [{ role: "system", content: "Tu es MCIA." }, ...(body.history || []), { role: "user", content: body.message || body.input || "" }];
    const response = await callNvidiaKimi(messages);
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ response, model_used: "kimi-fallback" }));
  }

  // Cas B : Ping avec cache 5 min
  if (pathname === "/mcia/chat/ping") {
    const cached = paCache.get("ping");
    if (cached && Date.now() - cached.time < PA_CACHE_TTL) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(cached.data);
    }
  }

  // Cas C : toutes les autres routes (Hymnes, Programmes, Glorias, JIC, etc.)
  try {
    if (!PYTHONANYWHERE_BASE) {
      res.writeHead(502, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Upstream (PythonAnywhere) non configuré" }));
    }
    const result = await forwardToPA(pathname + qs, req.method, req);
    if (pathname === "/mcia/chat/ping") paCache.set("ping", { data: result.data, time: Date.now() });
    res.writeHead(result.status, { "Content-Type": "application/json" });
    res.end(result.data);
  } catch (err) {
    console.warn("[mcia_service] forwardToPA error:", err && err.message ? err.message : err);
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Upstream down" }));
  }
}

const PA_PREFIXES = ["/mcia", "/hymns", "/programmes", "/programme", "/import-programmes", "/glorias", "/jic", "/updates", "/login"];

// ─── Request handlers ─────────────────────────────────────────────────────────

async function handleGenerate(req, res) {
  const ip = getClientIP(req);

  // Auth check
  if (CLIENT_API_KEY) {
    const key = req.headers["x-client-key"] || req.headers["x-api-key"];
    if (!key || key !== CLIENT_API_KEY)
      return jsonRes(res, 401, { status: "ERROR", message: "Unauthorized" });
  }

  // Rate limit check
  if (!checkRateLimit(ip)) {
    return jsonRes(res, 429, {
      status: "ERROR",
      message: "Daily limit reached (" + DAILY_LIMIT + " generations). Come back tomorrow."
    });
  }

  let payload;
  try { payload = await parseBody(req); }
  catch (e) { return jsonRes(res, 400, { status: "ERROR", message: e.message }); }

  // ── ACE-Step (Default) → NOUVELLE chaîne v2 + fallback Sonauto ────────────
  if (payload.engine !== "sonauto") {
    const audioErr = validateAudioSource(payload);
    if (audioErr) return jsonRes(res, 400, { status: "ERROR", message: audioErr });

    // Modes avancés (remix/repaint/...) : nécessitent l'ancienne API audio-source
    // que la v2 ne couvre pas encore via ce proxy — rejet explicite et clair.
    const advancedMode = ["remix", "repaint", "retake", "lego", "complete"].includes(payload.mode);
    if (advancedMode && !payload.messages?.some?.(m => Array.isArray(m.content))) {
      return jsonRes(res, 400, { status: "ERROR", message: "Mode '" + payload.mode + "' non supporté par cette version du proxy" });
    }

    const taskId = `acestep-${Date.now()}`;
    incrementRate(ip);
    jsonRes(res, 200, { status: "SUBMITTED", taskId });
    logi(`${taskId} SUBMITTED (engine=acestep, chaîne v2→Sonauto)`);
    runAcestepGeneration(taskId, payload);
    return;
  }

  // ── Sonauto direct (inchangé — SonautoScreen) ─────────────────────────────
  try {
    if (!SONAUTO_API_KEY) throw new Error("Missing EXPO_PUBLIC_SONAUTO_API_KEY on server");
    const { mode, prompt, lyrics, tags, instrumental, num_songs } = payload;
    const prompt_strength  = payload.prompt_strength ?? 1.0;
    const balance_strength = payload.balance_strength ?? 0.8;
    const style_scale      = payload.style_scale ?? 3.0;
    if (!mode) throw new Error("mode required: simple|custom|instrumental");

    let body;
    if (mode === "instrumental") {
      body = { prompt: prompt || "A calm instrumental", instrumental: true,
               num_songs: num_songs || 2, output_format: "mp3",
               prompt_strength, balance_strength, style_scale, seed: 2025 };
    } else if (mode === "custom") {
      if (!lyrics) throw new Error("lyrics required for custom mode");
      body = { lyrics, tags: tags || ["pop", "emotional"], instrumental: false,
               num_songs: num_songs || 2, output_format: "mp3",
               prompt_strength, balance_strength, style_scale, seed: 2025 };
    } else {
      if (!prompt) throw new Error("prompt required for simple mode");
      body = { prompt, tags: tags || ["pop", "emotional"], instrumental: !!instrumental,
               num_songs: num_songs || 2, output_format: "mp3",
               prompt_strength, balance_strength, style_scale, seed: 2025 };
    }

    const genRes = await sonautoCall("/generations/v3", "POST", body);
    const taskId = genRes?.task_id || genRes?.id;
    if (!taskId) throw new Error("No task_id in Sonauto response");

    incrementRate(ip);
    jsonRes(res, 200, { status: "SUBMITTED", taskId });
    pollSonauto(taskId, mode);
  } catch (err) {
    loge("Sonauto direct /generate:", err.message);
    jsonRes(res, 400, { status: "ERROR", message: err.message || "Unknown" });
  }
}

async function handleStatus(req, res, taskId) {
  // ── Tâches acestep-* : store mémoire local (v2 OU fallback Sonauto) ───────
  if (taskId.startsWith("acestep-")) {
    const entry = audioStore.get(taskId);
    if (!entry) {
      // Pas encore enregistré (juste soumis) ou TTL expiré
      return jsonRes(res, 200, { status: "PROCESSING" });
    }
    if (entry.error) {
      // VRAIE erreur diagnostique (le message "saturé" affiché côté APK est
      // géré par l'application — ici on expose la cause réelle pour les logs)
      return jsonRes(res, 200, {
        status: "FAILURE",
        error_message: entry.error,
        message: entry.error,
      });
    }
    if (entry.buffer) {
      return jsonRes(res, 200, {
        status:     "SUCCESS",
        song_paths: [`/download/${encodeURIComponent(taskId)}`],
      });
    }
    return jsonRes(res, 200, { status: "PROCESSING", engine: entry.engine || "pending" });
  }

  // ── Sonauto direct (inchangé) ─────────────────────────────────────────────
  try {
    const data = await sonautoCall(`/generations/${taskId}`, "GET");
    jsonRes(res, 200, data);
  } catch (err) {
    jsonRes(res, 400, { status: "ERROR", message: err.message });
  }
}

async function handleDownloadById(res, taskId) {
  // ── From memory ───────────────────────────────────────────────────────────
  const entry = audioStore.get(taskId);
  if (entry?.buffer) {
    res.writeHead(200, {
      "Content-Type":        "audio/mpeg",
      "Content-Disposition": `attachment; filename="${taskId}.mp3"`,
      "Content-Length":      entry.buffer.length,
    });
    return res.end(entry.buffer);
  }

  // ── From S3 (if configured) ───────────────────────────────────────────────
  if (USE_S3 && s3) {
    try {
      const obj = await s3.getObject({
        Bucket: process.env.AWS_S3_BUCKET,
        Key:    `acemusic/${taskId}.mp3`,
      }).promise();
      res.writeHead(200, {
        "Content-Type":        "audio/mpeg",
        "Content-Disposition": `attachment; filename="${taskId}.mp3"`,
      });
      return res.end(obj.Body);
    } catch { /* fall through */ }
  }

  // ── From disk (AUTO_DOWNLOAD=true only) ───────────────────────────────────
  if (AUTO_DOWNLOAD) {
    const filePath = path.join(OUTPUT_DIR, `${taskId}.mp3`);
    if (fs.existsSync(filePath)) {
      res.writeHead(200, {
        "Content-Type":        "audio/mpeg",
        "Content-Disposition": `attachment; filename="${taskId}.mp3"`,
      });
      return fs.createReadStream(filePath).pipe(res);
    }
  }

  jsonRes(res, 404, { status: "ERROR", message: "Audio not found or expired" });
}

async function handleDownloadProxy(res, trackUrl) {
  if (!trackUrl) return jsonRes(res, 400, { status: "ERROR", message: "Missing url" });
  if (!isSonautoHost(trackUrl)) return jsonRes(res, 400, { status: "ERROR", message: "URL not allowed" });
  try {
    const headers = SONAUTO_API_KEY ? { Authorization: `Bearer ${SONAUTO_API_KEY}` } : {};
    const r       = await fetch(trackUrl, { headers });
    if (!r.ok) return jsonRes(res, 502, { status: "ERROR", message: `Upstream ${r.status}` });
    res.writeHead(200, {
      "Content-Type":        r.headers.get("content-type") || "audio/mpeg",
      "Content-Disposition": 'attachment; filename="track.mp3"',
    });
    await streamPipeline(r.body, res);
  } catch (err) {
    jsonRes(res, 500, { status: "ERROR", message: err.message });
  }
}

// ─── HTTP Server ──────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const { pathname, query } = urlModule.parse(req.url, true);

  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-KEY, X-CLIENT-KEY");

  if (req.method === "OPTIONS") { res.writeHead(200); res.end(); return; }

  // ── Routes MCIA & app.py (forwarding PythonAnywhere — ex-mcia_service.js) ──
  if (PA_PREFIXES.some(p => pathname.startsWith(p))) {
    return handleMciaRoutes(req, res, pathname);
  }

  // Health check
  if (pathname === "/health" && req.method === "GET") {
    return jsonRes(res, 200, {
      status:         "ok",
      service:        "Music AI Proxy",
      engine:         "Undici-KeepAlive",
      acestep_v2:     ACESTEP_V2_API_KEY ? "configured" : "not-configured (fallback Sonauto)",
      sonauto:        SONAUTO_API_KEY ? "configured" : "MISSING",
      pa_forwarding:  PYTHONANYWHERE_BASE ? "on" : "off",
      store:          audioStore.size,
      patched:        "2026-08-30",
    });
  }

  // Static UI (optional)
  const htmlPath = path.join(__dirname, "public", "index.html");
  if ((pathname === "/" || pathname === "/ui") && req.method === "GET" && fs.existsSync(htmlPath)) {
    res.writeHead(200, { "Content-Type": "text/html" });
    return res.end(fs.readFileSync(htmlPath, "utf-8"));
  }

  if (pathname === "/generate"          && req.method === "POST") return handleGenerate(req, res);
  if (pathname.startsWith("/status/")   && req.method === "GET")  return handleStatus(req, res, pathname.split("/")[2]);
  if (pathname.startsWith("/download/") && req.method === "GET")  return handleDownloadById(res, decodeURIComponent(pathname.split("/")[2]));
  if (pathname === "/download"          && req.method === "GET")  return handleDownloadProxy(res, query.url);

  jsonRes(res, 404, { status: "ERROR", message: "Not found" });
});

server.listen(PORT, () => {
  logi(`Music AI Proxy (PATCH 2026-08-30) · port ${PORT} · ACE-Step v2=${ACESTEP_V2_API_KEY ? "OUI" : "non (fallback Sonauto)"} · Sonauto=${SONAUTO_API_KEY ? "OUI" : "MANQUANT"} · S3=${USE_S3} · disk=${AUTO_DOWNLOAD} · dailyLimit=${DAILY_LIMIT}`);
});

// ─── Keep-alive ───────────────────────────────────────────────────────────────

const KEEP_ALIVE_URL      = process.env.KEEP_ALIVE_URL || null;
const KEEP_ALIVE_INTERVAL = parseInt(process.env.KEEP_ALIVE_INTERVAL_MS) || 4 * 60 * 1000;

if (KEEP_ALIVE_URL) {
  const ping = async () => {
    try {
      const ctrl = new AbortController();
      const tid  = setTimeout(() => ctrl.abort(), 8000);
      await fetch(KEEP_ALIVE_URL, { signal: ctrl.signal });
      clearTimeout(tid);
    } catch { /* silent */ }
  };
  ping();
  setInterval(ping, KEEP_ALIVE_INTERVAL);
  process.on("SIGINT",  () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
}
