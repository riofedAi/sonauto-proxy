/**
 * server.js — Proxy Sonauto avec UI web
 * Node.js 18+ (fetch natif, pas de dépendances)
 * 
 * Usage: node server.js
 * Ouvrez http://localhost:3000
 */

require("dotenv").config();
const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");

// =================== CONFIG ===================
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.EXPO_PUBLIC_SONAUTO_API_KEY;
// If AUTO_DOWNLOAD is 'true' the server will save generated MP3s to ./downloads
// Otherwise it will skip automatic saving (recommended for production on Render)
const AUTO_DOWNLOAD = process.env.AUTO_DOWNLOAD === 'true';
const BASE_URL = "https://api.sonauto.ai/v1";
const OUTPUT_DIR = path.join(process.cwd(), "downloads");

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// ================ HELPERS ================

async function apiCall(endpoint, method = "GET", body = null, customHeaders = {}) {
  const fullUrl = `${BASE_URL}${endpoint}`;
  const headers = {
    Authorization: `Bearer ${API_KEY}`,
    "Content-Type": "application/json",
    ...customHeaders,
  };

  const options = {
    method,
    headers,
  };

  if (body) options.body = JSON.stringify(body);

  const res = await fetch(fullUrl, options);
  if (!res.ok) {
    const errData = await res.text();
    throw new Error(`API error (${res.status}): ${errData}`);
  }
  return res.json();
}

async function downloadAndSaveTrack(url, filename) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status})`);

  const buffer = await res.arrayBuffer();
  const filePath = path.join(OUTPUT_DIR, filename);
  fs.writeFileSync(filePath, Buffer.from(buffer));
  return filePath;
}

// ================ SERVER ================

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }

  // GET / — Servir la page HTML
  if (pathname === "/" && req.method === "GET") {
    const htmlPath = path.join(__dirname, "public", "index.html");
    if (fs.existsSync(htmlPath)) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(fs.readFileSync(htmlPath, "utf-8"));
      return;
    }
    // Fallback si public/index.html n'existe pas
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`
      <!DOCTYPE html>
      <html>
      <head><title>Sonauto Test</title></head>
      <body>
        <h1>Sonauto Proxy</h1>
        <p>Serveur actif sur http://localhost:3000</p>
      </body>
      </html>
    `);
    return;
  }

  // POST /generate — Lancer la génération Sonauto
  if (pathname === "/generate" && req.method === "POST") {
    let bodyData = "";
    req.on("data", (chunk) => {
      bodyData += chunk.toString();
    });
    req.on("end", async () => {
      try {
        if (!API_KEY) {
          throw new Error("Clé API manquante. Définissez EXPO_PUBLIC_SONAUTO_API_KEY dans .env");
        }

        const payload = JSON.parse(bodyData);

        // Validation minimale
        if (!payload.mode) {
          throw new Error("Mode manquant (prompt, custom, ou instrumental)");
        }

        // Construire le payload pour Sonauto
        let sonautoPayload;

        if (payload.mode === "instrumental") {
          sonautoPayload = {
            prompt: payload.prompt || "A calm instrumental composition with warm piano and ambient sounds.",
            instrumental: true,
            num_songs: 2,
            output_format: "mp3",
            prompt_strength: 2.0,
            balance_strength: 0.7,
          };
        } else if (payload.mode === "prompt") {
          // Prompt mode : IA génère les paroles à partir du prompt
          if (!payload.prompt) {
            throw new Error("Prompt manquant pour le mode prompt");
          }
          sonautoPayload = {
            prompt: payload.prompt,
            tags: payload.tags || ["pop", "emotional", "modern"],
            instrumental: false,
            num_songs: 2,
            output_format: "mp3",
            prompt_strength: 2.0,
            balance_strength: 0.7,
          };
        } else if (payload.mode === "custom") {
          // Custom mode : paroles fournies par l'utilisateur
          if (!payload.lyrics) {
            throw new Error("Lyrics manquant pour le mode custom");
          }
          sonautoPayload = {
            lyrics: payload.lyrics,
            tags: payload.tags || ["pop", "emotional", "modern"],
            instrumental: false,
            num_songs: 2,
            output_format: "mp3",
            prompt_strength: 1.6,
            balance_strength: 0.7,
          };
        } else {
          throw new Error("Mode inconnu : utilisez prompt, custom, ou instrumental");
        }

        console.log("🎵 Envoi de la requête de génération...");
        console.log(`Mode: ${payload.mode}, Tags: ${(payload.tags || []).join(", ")}`);
        const genRes = await apiCall("/generations", "POST", sonautoPayload);
        const taskId = genRes.task_id;

        console.log(`🪄 Task ID: ${taskId}`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "SUBMITTED", taskId }));

        // Polling asynchrone en arrière-plan
        handlePolling(taskId, payload.mode);
      } catch (err) {
        console.error("❌ Erreur:", err.message);
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ERROR", message: err.message }));
      }
    });
    return;
  }

  // GET /status/:taskId — Vérifier le statut d'une tâche
  if (pathname.startsWith("/status/") && req.method === "GET") {
    const taskId = pathname.split("/")[2];
    try {
      if (!API_KEY) {
        throw new Error("Clé API manquante");
      }
      const statusRes = await apiCall(`/generations/${taskId}`, "GET");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(statusRes));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ERROR", message: err.message }));
    }
    return;
  }

  // GET /download?url=... — Stream a track through the proxy (no saving)
  if (pathname === "/download" && req.method === "GET") {
    const trackUrl = parsedUrl.query && parsedUrl.query.url;
    if (!trackUrl) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ERROR", message: "Missing url query parameter" }));
      return;
    }

    // Basic validation: allow only Sonauto domains
    try {
      const parsed = new URL(trackUrl);
      if (!parsed.hostname.includes("sonauto.ai")) {
        throw new Error("URL non autorisée");
      }
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ERROR", message: "Invalid track URL" }));
      return;
    }

    try {
      const headers = API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {};
      const trackRes = await fetch(trackUrl, { headers });
      if (!trackRes.ok) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ERROR", message: `Failed to fetch track (${trackRes.status})` }));
        return;
      }

      const contentType = trackRes.headers.get("content-type") || "audio/mpeg";
      const disposition = trackRes.headers.get("content-disposition") || 'attachment; filename="track.mp3"';
      const buffer = await trackRes.arrayBuffer();

      res.writeHead(200, { "Content-Type": contentType, "Content-Disposition": disposition });
      res.end(Buffer.from(buffer));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ERROR", message: err.message }));
    }
    return;
  }

  // 404
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

// ================ POLLING EN ARRIÈRE-PLAN ================

async function handlePolling(taskId, mode) {
  try {
    for (let i = 0; i < 150; i++) {
      await new Promise((r) => setTimeout(r, 4000));

      const statusRes = await apiCall(`/generations/${taskId}`, "GET");
      console.log(`→ Statut: ${statusRes.status}`);

      if (statusRes.status === "SUCCESS") {
        console.log("✅ Génération réussie !");
        const song_paths = statusRes.song_paths || [];

        for (let j = 0; j < song_paths.length; j++) {
          const url = song_paths[j];
          let baseName = "track";
          if (mode === "custom") baseName = "custom_lyrics";
          else if (mode === "prompt") baseName = "prompt_generated";
          else if (mode === "instrumental") baseName = "instrumental";

          const filename = `${baseName}_${j + 1}.mp3`;
          console.log(`⬇️ Téléchargement de ${filename}...`);
          const filePath = await downloadAndSaveTrack(url, filename);
          console.log(`💾 Fichier sauvegardé : ${filePath}`);
        }

        console.log("🎶 Terminé avec succès !");
        return;
      }

      if (statusRes.status === "FAILURE") {
        throw new Error(statusRes.error_message || "Échec inconnu");
      }
    }

    throw new Error("Temps d'attente dépassé (10 min)");
  } catch (err) {
    console.error("💥 Erreur lors du polling:", err.message);
  }
}

// ================ START ================

server.listen(PORT, () => {
  console.log(`\n🚀 Serveur Sonauto actif sur http://localhost:${PORT}`);
  console.log(`📄 Ouvrez http://localhost:${PORT} dans votre navigateur\n`);
});
