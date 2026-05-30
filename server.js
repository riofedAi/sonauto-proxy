// ─── Styles Sonauto tags endpoint ───────────────────────────────────────────────
const STYLES_PATH = path.join(__dirname, "sonauto_tags_v3.txt");

// ...dans la fonction du serveur HTTP, juste avant le 404 :
// if (pathname === "/styles" && req.method === "GET") ...

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
 * Security:
 *   - Daily rate limit: 8 generations / IP / day
 *   - Max body size: 25 MB
 *   - Audio validation: base64 size check, format check
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

const PORT              = process.env.PORT || 3000;
const SONAUTO_API_KEY   = process.env.EXPO_PUBLIC_SONAUTO_API_KEY;
const ACESTEP_API_KEY   = process.env.ACESTEP_API_KEY || "";
const ACESTEP_BASE_URL  = process.env.ACESTEP_BASE_URL || "https://api.acemusic.ai";
const CLIENT_API_KEY    = process.env.CLIENT_API_KEY || null;
const AUTO_DOWNLOAD     = process.env.AUTO_DOWNLOAD === "true";
const SONAUTO_BASE_URL  = "https://api.sonauto.ai/v1";
const IN_MEMORY_TTL     = parseInt(process.env.IN_MEMORY_TTL_MS) || 30 * 60 * 1000; // 30 min
const DAILY_LIMIT       = parseInt(process.env.DAILY_LIMIT) || 8;
const MAX_BODY_SIZE     = (parseInt(process.env.MAX_BODY_SIZE_MB) || 25) * 1024 * 1024; // 25 MB
const MAX_AUDIO_BASE64  = 15 * 1024 * 1024; // ~15 MB base64 (~10 MB raw audio, ~90s of high-quality mp3)

const audioStore = new Map();

// ... le reste du code est inchangé, puis dans la section du serveur :

const server = http.createServer(async (req, res) => {
  const { pathname, query } = urlModule.parse(req.url, true);

  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-CLIENT-KEY, Authorization");

  if (req.method === "OPTIONS") { res.writeHead(200); res.end(); return; }

  // Health check
  if (pathname === "/health" && req.method === "GET") {
    return jsonRes(res, 200, {
      status:  "ok",
      service: "Music AI Proxy",
      store:   audioStore.size,
    });
  }

  // Static UI (optional)
  const htmlPath = path.join(__dirname, "public", "index.html");
  if ((pathname === "/" || pathname === "/ui") && req.method === "GET" && fs.existsSync(htmlPath)) {
    res.writeHead(200, { "Content-Type": "text/html" });
    return res.end(fs.readFileSync(htmlPath, "utf-8"));
  }

  // Nouvelle route /styles
  if (pathname === "/styles" && req.method === "GET") {
    if (fs.existsSync(STYLES_PATH)) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end(fs.readFileSync(STYLES_PATH, "utf-8"));
    } else {
      return jsonRes(res, 404, { status: "ERROR", message: "Styles file not found" });
    }
  }

  if (pathname === "/generate"          && req.method === "POST") return handleGenerate(req, res);
  if (pathname.startsWith("/status/")   && req.method === "GET")  return handleStatus(req, res, pathname.split("/")[2]);
  if (pathname.startsWith("/download/") && req.method === "GET")  return handleDownloadById(res, decodeURIComponent(pathname.split("/")[2]));
  if (pathname === "/download"          && req.method === "GET")  return handleDownloadProxy(res, query.url);

  jsonRes(res, 404, { status: "ERROR", message: "Not found" });
});

// ...
