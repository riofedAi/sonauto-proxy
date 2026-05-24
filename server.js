/**
 * server.js — Music AI Proxy
 * Engines: ACE-Step (text, remix, repaint, retake, lego, complete) + Sonauto
 * Node.js 18+
 *
 * Storage strategy:
 *   - ACE-Step audio stored in-memory (Map) — no disk dependency
 *   - Optional S3 for persistence across restarts (AWS_S3_BUCKET + credentials)
 *   - AUTO_DOWNLOAD=false recommended on Render (ephemeral disk)
 *
 * Env variables:
 *   EXPO_PUBLIC_SONAUTO_API_KEY   — Sonauto API key
 *   ACESTEP_API_KEY               — ACE-Step API key
 *   ACESTEP_BASE_URL              — default: https://api.acemusic.ai
 *   CLIENT_API_KEY                — optional: protect /generate (X-CLIENT-KEY header)
 *   PORT                          — default: 3000
 *   KEEP_ALIVE_URL                — public URL for self-ping (prevents Render sleep)
 *   KEEP_ALIVE_INTERVAL_MS        — default: 240000 (4 min)
 *   AUTO_DOWNLOAD                 — save Sonauto tracks to disk (default: false)
 *   AWS_S3_BUCKET / AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION — optional
 *   IN_MEMORY_TTL_MS              — how long to keep audio in memory (default: 30 min)
 */

require("dotenv").config();

const http          = require("http");
const fs            = require("fs");
const path          = require("path");
const urlModule     = require("url");
const { pipeline }  = require("stream");
const { promisify } = require("util");
const streamPipeline = promisify(pipeline);

// ─── Config ──────────────────────────────────────────────────────────────────

const PORT             = process.env.PORT || 3000;
const SONAUTO_API_KEY  = process.env.EXPO_PUBLIC_SONAUTO_API_KEY;
const ACESTEP_API_KEY  = process.env.ACESTEP_API_KEY || "";
const ACESTEP_BASE_URL = process.env.ACESTEP_BASE_URL || "https://api.acemusic.ai";
const CLIENT_API_KEY   = process.env.CLIENT_API_KEY || null;
const AUTO_DOWNLOAD    = process.env.AUTO_DOWNLOAD === "true";
const SONAUTO_BASE_URL = "https://api.sonauto.ai/v1";
const IN_MEMORY_TTL    = parseInt(process.env.IN_MEMORY_TTL_MS) || 30 * 60 * 1000; // 30 min

// ─── In-memory store (ACE-Step audio) ────────────────────────────────────────
// Map<taskId, { buffer: Buffer, expiresAt: number, error?: string }>

const audioStore = new Map();

function storeAudio(taskId, buffer) {
  audioStore.set(taskId, { buffer, expiresAt: Date.now() + IN_MEMORY_TTL });
  // Auto-cleanup after TTL
  setTimeout(() => audioStore.delete(taskId), IN_MEMORY_TTL);
}

function storeError(taskId, message) {
  audioStore.set(taskId, { error: message, expiresAt: Date.now() + IN_MEMORY_TTL });
  setTimeout(() => audioStore.delete(taskId), IN_MEMORY_TTL);
}

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
    req.on("data", c => (raw += c));
    req.on("end", () => {
      try { resolve(JSON.parse(raw || "{}")); }
      catch (e) { reject(new Error("Invalid JSON body")); }
    });
    req.on("error", reject);
  });
}

async function safeJson(res) {
  const text = await res.text();
  try { return JSON.parse(text); }
  catch { return { _raw: text }; }
}

function jsonRes(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function isSonautoHost(trackUrl) {
  try { return new URL(trackUrl).hostname.includes("sonauto.ai"); }
  catch { return false; }
}

// ─── Sonauto API call ─────────────────────────────────────────────────────────

async function sonautoCall(endpoint, method = "GET", body = null) {
  if (!SONAUTO_API_KEY) throw new Error("Missing EXPO_PUBLIC_SONAUTO_API_KEY");
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${SONAUTO_API_KEY}`,
      "Content-Type": "application/json",
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const r    = await fetch(`${SONAUTO_BASE_URL}${endpoint}`, opts);
  const data = await safeJson(r);
  if (!r.ok) {
    const err  = new Error(`Sonauto (${r.status}): ${data._raw ?? JSON.stringify(data)}`);
    err.status = r.status;
    throw err;
  }
  return data;
}

// ─── ACE-Step call ────────────────────────────────────────────────────────────

async function acestepCall(payload, timeoutMs = 9 * 60 * 1000) {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers = { "Content-Type": "application/json" };
    if (ACESTEP_API_KEY) headers["Authorization"] = `Bearer ${ACESTEP_API_KEY}`;
    const r    = await fetch(`${ACESTEP_BASE_URL}/v1/chat/completions`, {
      method: "POST", headers,
      body:   JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const data = await safeJson(r);
    if (!r.ok) throw new Error(`ACE-Step (${r.status}): ${JSON.stringify(data)}`);
    return data;
  } finally {
    clearTimeout(tid);
  }
}

// ─── Extract audio URL from ACE-Step response ─────────────────────────────────

function extractAudioUrl(response) {
  const msg = response?.choices?.[0]?.message;
  if (!msg) throw new Error("No choices in ACE-Step response");
  // Try both response shapes
  const audioArr = msg.audio || (msg.audio_url ? [{ audio_url: msg.audio_url }] : null);
  if (!audioArr?.length) throw new Error("No audio in ACE-Step response");
  const url = audioArr[0]?.audio_url?.url;
  if (!url) throw new Error("No audio URL in ACE-Step response");
  return url;
}

// ─── Save audio (memory + optional S3/disk) ───────────────────────────────────

async function saveAudio(taskId, dataUrl) {
  const b64    = dataUrl.replace(/^data:audio\/\w+;base64,/, "");
  const buffer = Buffer.from(b64, "base64");

  // Always store in memory for /download/:taskId
  storeAudio(taskId, buffer);

  // Optional: persist to S3
  if (USE_S3 && s3) {
    await s3.putObject({
      Bucket:      process.env.AWS_S3_BUCKET,
      Key:         `acemusic/${taskId}.mp3`,
      Body:        buffer,
      ContentType: "audio/mpeg",
    }).promise();
  }

  // Optional: persist to disk (only meaningful on non-ephemeral hosting)
  if (AUTO_DOWNLOAD) {
    fs.writeFileSync(path.join(OUTPUT_DIR, `${taskId}.mp3`), buffer);
  }
}

// ─── Build ACE-Step payload ───────────────────────────────────────────────────

function buildAcestepPayload(payload) {
  // If mobile app already built the full messages array, pass through
  if (payload.messages) {
    const p = {
      model:          payload.model || "acemusic/acestep-v1.5-xl-turbo",
      messages:       payload.messages,
      duration:       payload.duration  || 60,
      vocal_language: payload.vocal_language || "en",
      instrumental:   payload.instrumental  || false,
      thinking:       payload.thinking !== undefined ? payload.thinking : true,
    };
    if (payload.task_type)        p.task_type        = payload.task_type;
    if (payload.bpm)              p.bpm              = payload.bpm;
    if (payload.audio_cover_strength !== undefined) p.audio_cover_strength = payload.audio_cover_strength;
    if (payload.repaint_start  !== undefined) p.repaint_start  = payload.repaint_start;
    if (payload.repaint_end    !== undefined) p.repaint_end    = payload.repaint_end;
    if (payload.retake_variance !== undefined) p.retake_variance = payload.retake_variance;
    return p;
  }

  // Legacy path (simple server-side build)
  const { mode, prompt, lyrics, instrumental, duration, vocal_language } = payload;
  let content;
  if (mode === "instrumental") {
    content = `<prompt>${prompt || "A calm instrumental"}</prompt><lyrics>[inst]</lyrics>`;
  } else if (mode === "custom") {
    content = `${prompt ? `<prompt>${prompt}</prompt>` : ""}<lyrics>${lyrics || ""}</lyrics>`;
  } else {
    content = prompt || "A beautiful song";
  }
  return {
    model:          "acemusic/acestep-v1.5-xl-turbo",
    messages:       [{ role: "user", content }],
    duration:       duration || 60,
    vocal_language: vocal_language || "en",
    instrumental:   mode === "instrumental" || !!instrumental,
    thinking:       false,
  };
}

// ─── ACE-Step generation (background) ────────────────────────────────────────

async function runAcestepGeneration(taskId, payload) {
  try {
    const acPayload = buildAcestepPayload(payload);
    const response  = await acestepCall(acPayload);
    const audioUrl  = extractAudioUrl(response);
    await saveAudio(taskId, audioUrl);
  } catch (err) {
    const msg = err.name === "AbortError"
      ? "Timeout (9 min) — ACE-Step took too long"
      : (err.message || "Unknown error");
    storeError(taskId, msg);
  }
}

// ─── Sonauto background polling ───────────────────────────────────────────────

async function pollSonauto(taskId, mode) {
  const max      = parseInt(process.env.MAX_POLL_ATTEMPTS) || 60;
  const baseMs   = parseInt(process.env.POLL_BASE_DELAY_MS) || 4000;
  let   attempt  = 0;

  while (attempt < max) {
    attempt++;
    try {
      const data = await sonautoCall(`/generations/${taskId}`, "GET");
      if (data.status === "SUCCESS") {
        if (AUTO_DOWNLOAD) {
          for (let i = 0; i < (data.song_paths || []).length; i++) {
            const filename = `sonauto_${mode}_${taskId}_${i + 1}.mp3`;
            const r        = await fetch(data.song_paths[i]);
            if (r.ok) {
              const ws = fs.createWriteStream(path.join(OUTPUT_DIR, filename));
              await streamPipeline(r.body, ws).catch(() => {});
            }
          }
        }
        return;
      }
      if (data.status === "FAILURE") return;
    } catch { /* keep polling */ }
    await new Promise(r => setTimeout(r, Math.min(baseMs * Math.pow(1.2, attempt), 20000)));
  }
}

// ─── Request handlers ─────────────────────────────────────────────────────────

async function handleGenerate(req, res) {
  if (CLIENT_API_KEY) {
    const key = req.headers["x-client-key"] || req.headers["x-api-key"];
    if (!key || key !== CLIENT_API_KEY)
      return jsonRes(res, 401, { status: "ERROR", message: "Unauthorized" });
  }

  let payload;
  try { payload = await parseBody(req); }
  catch (e) { return jsonRes(res, 400, { status: "ERROR", message: e.message }); }

  // ── ACE-Step (Default) ─────────────────────────────────────────────────────
  if (payload.engine !== "sonauto") {
    const taskId = `acestep-${Date.now()}`;
    jsonRes(res, 200, { status: "SUBMITTED", taskId });
    runAcestepGeneration(taskId, payload);
    return;
  }

  // ── Sonauto ───────────────────────────────────────────────────────────────
  try {
    if (!SONAUTO_API_KEY) throw new Error("Missing EXPO_PUBLIC_SONAUTO_API_KEY on server");
    const { mode, prompt, lyrics, tags, instrumental, num_songs } = payload;
    if (!mode) throw new Error("mode required: simple|custom|instrumental");

    let body;
    if (mode === "instrumental") {
      body = { prompt: prompt || "A calm instrumental", instrumental: true,
               num_songs: num_songs || 2, output_format: "mp3",
               prompt_strength: 2.5, balance_strength: 0.8, seed: 2025 };
    } else if (mode === "custom") {
      if (!lyrics) throw new Error("lyrics required for custom mode");
      body = { lyrics, tags: tags || ["pop", "emotional"], instrumental: false,
               num_songs: num_songs || 2, output_format: "mp3",
               prompt_strength: 2.5, balance_strength: 0.8, seed: 2025 };
    } else {
      if (!prompt) throw new Error("prompt required for simple mode");
      body = { prompt, tags: tags || ["pop", "emotional"], instrumental: !!instrumental,
               num_songs: num_songs || 2, output_format: "mp3",
               prompt_strength: 2.5, balance_strength: 0.8, seed: 2025 };
    }

    const genRes = await sonautoCall("/generations/v3", "POST", body);
    const taskId = genRes?.task_id || genRes?.id;
    if (!taskId) throw new Error("No task_id in Sonauto response");

    jsonRes(res, 200, { status: "SUBMITTED", taskId });
    pollSonauto(taskId, mode);
  } catch (err) {
    jsonRes(res, 400, { status: "ERROR", message: err.message || "Unknown" });
  }
}

async function handleStatus(req, res, taskId) {
  // ── ACE-Step: check in-memory store ───────────────────────────────────────
  if (taskId.startsWith("acestep-")) {
    const entry = audioStore.get(taskId);
    if (!entry) {
      // Not done yet
      return jsonRes(res, 200, { status: "PROCESSING" });
    }
    if (entry.error) {
      return jsonRes(res, 200, { status: "FAILURE", error_message: entry.error });
    }
    // Build download URL (relative — client prepends proxy base URL)
    return jsonRes(res, 200, {
      status:     "SUCCESS",
      song_paths: [`/download/${encodeURIComponent(taskId)}`],
    });
  }

  // ── Sonauto ───────────────────────────────────────────────────────────────
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
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-CLIENT-KEY, Authorization");

  if (req.method === "OPTIONS") { res.writeHead(200); res.end(); return; }

  // Health check
  if ((pathname === "/" || pathname === "/health") && req.method === "GET") {
    return jsonRes(res, 200, {
      status:  "ok",
      service: "Music AI Proxy",
      store:   audioStore.size,   // how many tasks in memory
    });
  }

  // Static UI (optional)
  const htmlPath = path.join(__dirname, "public", "index.html");
  if (pathname === "/ui" && fs.existsSync(htmlPath)) {
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
  console.log(`[proxy] Music AI Proxy · port ${PORT} · S3=${USE_S3} · disk=${AUTO_DOWNLOAD}`);
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
