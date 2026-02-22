/**
 * server.js — Sonauto Proxy PRO
 * Node.js 18+ (uses global fetch)
 *
 * Features:
 * - Robust polling with exponential backoff and max attempts
 * - Safe parsing of Sonauto responses (handles non-JSON)
 * - Keep-alive internal pinger (configurable via env)
 * - Optional simple API key for clients (X-CLIENT-KEY or header)
 * - Optional S3 upload (if AWS env vars provided)
 * - Download proxy limited to sonauto.ai hosts
 * - Structured console logs for easier debugging on Render
 *
 * Env variables:
 * - EXPO_PUBLIC_SONAUTO_API_KEY (required)
 * - AUTO_DOWNLOAD (false recommended on Render)
 * - ENABLE_KEEP_ALIVE (true/false)
 * - KEEP_ALIVE_URL (default uses public URL)
 * - KEEP_ALIVE_INTERVAL_MS (ms)
 * - CLIENT_API_KEY (optional; protect /generate)
 * - AWS_S3_BUCKET, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION (optional for S3 upload)
 * - PORT (optional)
 */

require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { pipeline } = require('stream');
const { promisify } = require('util');
const streamPipeline = promisify(pipeline);

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.EXPO_PUBLIC_SONAUTO_API_KEY;
const AUTO_DOWNLOAD = process.env.AUTO_DOWNLOAD === 'true';
const BASE_URL = 'https://api.sonauto.ai/v1';
const OUTPUT_DIR = path.join(process.cwd(), 'songs');

// ACE-Step configuration
const ACESTEP_API_KEY = process.env.ACESTEP_API_KEY || ''; // fallback if needed
const ACESTEP_BASE_URL = process.env.ACESTEP_BASE_URL || 'https://api.acemusic.ai';

// Optional client-side API key (simple protection)
const CLIENT_API_KEY = process.env.CLIENT_API_KEY || null;

// S3 optional (lazy require)
let s3 = null;
const USE_S3 = !!(process.env.AWS_S3_BUCKET && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
if (USE_S3) {
  const AWS = require('aws-sdk');
  AWS.config.update({ region: process.env.AWS_REGION || 'us-east-1' });
  s3 = new AWS.S3();
}

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// Helper: safe JSON parse (returns null on failure)
async function safeJsonResponse(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    // Not JSON
    return { _raw: text };
  }
}

// Helper: call Sonauto and return object or throw
async function apiCall(endpoint, method = 'GET', body = null, customHeaders = {}) {
  if (!API_KEY) throw new Error('Missing Sonauto API key (EXPO_PUBLIC_SONAUTO_API_KEY)');
  const fullUrl = `${BASE_URL}${endpoint}`;
  const headers = {
    Authorization: `Bearer ${API_KEY}`,
    'Content-Type': 'application/json',
    ...customHeaders,
  };
  const options = { method, headers };
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(fullUrl, options);
  const parsed = await safeJsonResponse(res);
  if (!res.ok) {
    const payload = (parsed && parsed._raw) ? parsed._raw : JSON.stringify(parsed);
    const err = new Error(`API error (${res.status}): ${payload}`);
    err.status = res.status;
    throw err;
  }
  return parsed;
}

// Download and optionally upload to S3
async function downloadAndSaveTrack(trackUrl, filename) {
  const res = await fetch(trackUrl);
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const filePath = path.join(OUTPUT_DIR, filename);

  // Stream to file
  const fileStream = fs.createWriteStream(filePath);
  await streamPipeline(res.body, fileStream);

  if (USE_S3 && s3) {
    const fileBody = fs.readFileSync(filePath);
    const params = {
      Bucket: process.env.AWS_S3_BUCKET,
      Key: `sonauto/${filename}`,
      Body: fileBody,
      ContentType: 'audio/mpeg',
      ACL: 'private',
    };
    await s3.putObject(params).promise();
    return { path: filePath, s3Key: params.Key };
  }

  return { path: filePath };
}

// Basic validators
function isAllowedTrackHostname(trackUrl) {
  try {
    const u = new URL(trackUrl);
    return u.hostname.endsWith('sonauto.ai') || u.hostname.includes('sonauto.ai');
  } catch (e) {
    return false;
  }
}

// Simple logger wrapper
function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

// Create server
const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // CORS for cross-origin clients (adjust origin in prod)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CLIENT-KEY');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Root UI
  if (pathname === '/' && req.method === 'GET') {
    const htmlPath = path.join(__dirname, 'public', 'index.html');
    if (fs.existsSync(htmlPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(fs.readFileSync(htmlPath, 'utf-8'));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Sonauto Proxy');
    return;
  }

  // POST /generate
  if (pathname === '/generate' && req.method === 'POST') {
    // simple client API key check
    if (CLIENT_API_KEY) {
      const provided = req.headers['x-client-key'] || req.headers['x-api-key'];
      if (!provided || provided !== CLIENT_API_KEY) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ERROR', message: 'Unauthorized (invalid client key)' }));
        return;
      }
    }

    // read body
    let body = '';
    req.on('data', (chunk) => (body += chunk.toString()));
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const engine = payload.engine || 'sonauto'; // default to sonauto if not specified

        if (engine === 'acestep') {
          return handleAcestepGeneration(req, res, payload);
        }

        if (!API_KEY) throw new Error('Server missing Sonauto API key (EXPO_PUBLIC_SONAUTO_API_KEY)');

        if (!payload.mode) throw new Error('Mode missing (custom/prompt/instrumental)');

        // prepare sonauto payload
        let sonautoPayload;
        if (payload.mode === 'instrumental') {
          sonautoPayload = {
            prompt: payload.prompt || 'A calm instrumental composition with warm piano and ambient sounds.',
            instrumental: true,
            num_songs: payload.num_songs || 2,
            output_format: 'mp3',
            prompt_strength: payload.prompt_strength || 2.0,
            balance_strength: payload.balance_strength || 0.7,
          };
        } else if (payload.mode === 'prompt') {
          if (!payload.prompt) throw new Error('Prompt missing for prompt mode');
          sonautoPayload = {
            prompt: payload.prompt,
            tags: payload.tags || ['pop', 'emotional', 'modern'],
            instrumental: false,
            num_songs: payload.num_songs || 2,
            output_format: 'mp3',
            prompt_strength: payload.prompt_strength || 2.0,
            balance_strength: payload.balance_strength || 0.7,
          };
        } else if (payload.mode === 'custom') {
          if (!payload.lyrics) throw new Error('Lyrics missing for custom mode');
          sonautoPayload = {
            lyrics: payload.lyrics,
            tags: payload.tags || ['pop', 'emotional', 'modern'],
            instrumental: false,
            num_songs: payload.num_songs || 2,
            output_format: 'mp3',
            prompt_strength: payload.prompt_strength || 1.6,
            balance_strength: payload.balance_strength || 0.7,
          };
        } else {
          throw new Error('Unknown mode');
        }

        log('Submitting generation', { mode: payload.mode });
        const genRes = await apiCall('/generations', 'POST', sonautoPayload);
        const taskId = genRes && genRes.task_id ? genRes.task_id : (genRes && genRes.id) ? genRes.id : null;
        if (!taskId) {
          log('Unexpected generation response', genRes);
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ERROR', message: 'Invalid generation response', detail: genRes }));
          return;
        }

        log('Task submitted', taskId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'SUBMITTED', taskId }));

        // start background polling (fire-and-forget)
        handlePolling(taskId, payload.mode, payload);
      } catch (err) {
        log('Generate error', err.message || err);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ERROR', message: err.message || 'Unknown' }));
      }
    });
    return;
  }

  // GET /status/:taskId
  if (pathname.startsWith('/status/') && req.method === 'GET') {
    const taskId = pathname.split('/')[2];

    if (taskId.startsWith('acestep-')) {
      // Check if the file for this completed ACE-Step task exists
      const expectedFilename = `${taskId}.mp3`;
      const expectedPath = path.join(OUTPUT_DIR, expectedFilename);
      const s3KeyCheck = `sonauto/${expectedFilename}`; // Reuse sonauto dir in s3 or separate?

      if (fs.existsSync(expectedPath)) {
        let dlUrl = `/download/${encodeURIComponent(taskId)}`;
        // Mock Sonauto SUCCESS response
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'SUCCESS',
          song_paths: [dlUrl]
        }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'PROCESSING'
        }));
      }
      return;
    }

    try {
      if (!API_KEY) throw new Error('Missing Sonauto API key');
      const statusRes = await apiCall(`/generations/${taskId}`, 'GET');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(statusRes));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ERROR', message: err.message || 'Unknown' }));
    }
    return;
  }

  // GET /download/:taskId (ChatGPT format)
  if (pathname.startsWith('/download/') && req.method === 'GET') {
    const taskId = pathname.split('/')[2];
    if (taskId && taskId.startsWith('acestep-')) {
      const filename = `${taskId}.mp3`;
      const filePath = path.join(OUTPUT_DIR, filename);
      if (!fs.existsSync(filePath)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ERROR', message: 'File not found' }));
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Content-Disposition': `attachment; filename="${filename}"`,
      });
      const fileStream = fs.createReadStream(filePath);
      return streamPipeline(fileStream, res).catch(err => {
        log('Local download error', err.message);
      });
    }
  }

  // GET /download?url=...
  if (pathname === '/download' && req.method === 'GET') {
    const trackUrl = parsedUrl.query && parsedUrl.query.url;
    if (!trackUrl) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ERROR', message: 'Missing url query parameter' }));
      return;
    }

    if (!isAllowedTrackHostname(trackUrl)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ERROR', message: 'Track URL not allowed' }));
      return;
    }
    try {
      const headers = API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {};
      const trackRes = await fetch(trackUrl, { headers });
      if (!trackRes.ok) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ERROR', message: `Failed to fetch track (${trackRes.status})` }));
        return;
      }
      const contentType = trackRes.headers.get('content-type') || 'audio/mpeg';
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Disposition': 'attachment; filename="track.mp3"',
      });
      await streamPipeline(trackRes.body, res);
    } catch (err) {
      log('Download proxy error', err.message || err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ERROR', message: err.message || 'Unknown' }));
    }
    return;
  }


  // 404
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

// Robust polling with exponential backoff and optional S3 upload
async function handleAcestepGeneration(req, res, payload) {
  try {
    const taskId = `acestep-${Date.now()}`;

    // Respond immediately to unblock client
    log('Task submitted (ACE-Step)', taskId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ taskId })); // Matching chatgpt response format { taskId }

    // Run ACE-Step generation in background
    let openRouterMessages = [];
    if (payload.mode === 'instrumental') {
      openRouterMessages.push({
        role: "user",
        // Enforce prompt/lyrics tags specifically for openrouter proxy compatibility
        content: `<prompt>${payload.prompt || 'A calm instrumental composition'}</prompt><lyrics>[inst]</lyrics>`
      });
    } else if (payload.mode === 'custom') {
      openRouterMessages.push({
        role: "user",
        content: (payload.prompt ? `<prompt>${payload.prompt}</prompt>` : "") + `<lyrics>${payload.lyrics}</lyrics>`
      });
    } else {
      // prompt mode
      openRouterMessages.push({
        role: "user",
        content: payload.prompt || 'A pop song'
      });
    }

    const openRouterPayload = {
      model: "acemusic/acestep-v1.5-turbo",
      messages: openRouterMessages,
      instrumental: payload.mode === 'instrumental' || payload.instrumental,
      duration: payload.duration || 60,
      thinking: false, // Match chat gpt preference
    };

    log('ACE-Step calling backend...', openRouterPayload);
    const fetchOptions = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(openRouterPayload)
    };
    if (ACESTEP_API_KEY) {
      fetchOptions.headers['Authorization'] = `Bearer ${ACESTEP_API_KEY}`;
    }

    const aceres = await fetch(`${ACESTEP_BASE_URL}/v1/chat/completions`, fetchOptions);
    const parsed = await safeJsonResponse(aceres);

    if (!aceres.ok) {
      throw new Error(`ACE-Step API error (${aceres.status}): ${JSON.stringify(parsed)}`);
    }

    // Decode audio URL (matching chatgpt array destructuring)
    if (parsed.choices && parsed.choices[0] && parsed.choices[0].message && parsed.choices[0].message.audio) {
      // According to chatgpt, data.choices[0].message.audio_url.url. But OpenRouter_API.md says audio is an array!
      // Using correct schema derived from docs earlier:
      const audioArray = parsed.choices[0].message.audio;
      const audioUrl = audioArray[0].audio_url.url; // data:audio/mpeg;base64,...
      const b64Data = audioUrl.replace("data:audio/mpeg;base64,", "");

      const filename = `${taskId}.mp3`;
      const filePath = path.join(OUTPUT_DIR, filename);

      // Write directly from b64 string
      fs.writeFileSync(filePath, Buffer.from(b64Data, "base64"));
      log('ACE-Step done', filePath);

      // Optional S3 upload
      if (USE_S3 && s3) {
        const fileBody = fs.readFileSync(filePath);
        const params = {
          Bucket: process.env.AWS_S3_BUCKET,
          Key: `sonauto/${filename}`,
          Body: fileBody,
          ContentType: 'audio/mpeg',
          ACL: 'private',
        };
        await s3.putObject(params).promise();
        log('ACE-Step track uploaded to S3', params.Key);
      }
    } else {
      throw new Error('ACE-Step API returned no audio files in response');
    }

  } catch (err) {
    log('ACE-Step error:', err.message || err);
  }
}

async function handlePolling(taskId, mode, originalPayload = {}) {
  const maxAttempts = Number(process.env.MAX_POLL_ATTEMPTS) || 60;
  const baseDelay = Number(process.env.POLL_BASE_DELAY_MS) || 4000;
  let attempt = 0;

  try {
    while (attempt < maxAttempts) {
      attempt++;
      const statusRes = await apiCall(`/generations/${taskId}`, 'GET');
      log('Poll', { taskId, attempt, status: statusRes.status });

      if (statusRes.status === 'SUCCESS') {
        const song_paths = statusRes.song_paths || [];
        for (let j = 0; j < song_paths.length; j++) {
          const url = song_paths[j];
          const baseName = mode === 'custom' ? 'custom_lyrics' : (mode === 'prompt' ? 'prompt_generated' : 'instrumental');
          const filename = `${baseName}_${taskId}_${j + 1}.mp3`;

          if (AUTO_DOWNLOAD) {
            try {
              const info = await downloadAndSaveTrack(url, filename);
              log('Saved track', info);
            } catch (err) {
              log('Save failed', err.message || err);
            }
          }
        }
        log('Generation completed', taskId);
        return;
      }

      if (statusRes.status === 'FAILURE') {
        log('Generation failed', statusRes);
        return;
      }

      // backoff
      const delay = Math.min(baseDelay * Math.pow(1.2, attempt), 20000);
      await new Promise((r) => setTimeout(r, delay));
    }
    log('Polling timeout', { taskId });
  } catch (err) {
    log('Polling error', err.message || err);
  }
}

// Start server
server.listen(PORT, () => {
  log('Server listening', { port: PORT });
  log('Public URL (KEEP_ALIVE_URL):', process.env.KEEP_ALIVE_URL || 'unset');
});

// Keep-alive implementation
const KEEP_ALIVE_URL = process.env.KEEP_ALIVE_URL || process.env.PUBLIC_URL || null;
const KEEP_ALIVE_INTERVAL_MS = Number(process.env.KEEP_ALIVE_INTERVAL_MS) || 4 * 60 * 1000;
const KEEP_ALIVE_TIMEOUT_MS = Number(process.env.KEEP_ALIVE_TIMEOUT_MS) || 8 * 1000;
const ENABLE_KEEP_ALIVE = process.env.ENABLE_KEEP_ALIVE !== 'false';

let keepAliveId = null;
async function keepAlivePing() {
  if (!KEEP_ALIVE_URL) return;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), KEEP_ALIVE_TIMEOUT_MS);
  try {
    const res = await fetch(KEEP_ALIVE_URL, { method: 'GET', signal: controller.signal });
    log('Keep-alive ping', { status: res.status });
  } catch (err) {
    if (err.name === 'AbortError') log('Keep-alive: timeout');
    else log('Keep-alive: failed', err.message || err);
  } finally {
    clearTimeout(timeoutId);
  }
}

if (ENABLE_KEEP_ALIVE && KEEP_ALIVE_URL) {
  // run now and schedule
  keepAlivePing();
  keepAliveId = setInterval(keepAlivePing, KEEP_ALIVE_INTERVAL_MS);
  const cleanup = () => {
    if (keepAliveId) clearInterval(keepAliveId);
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
}
