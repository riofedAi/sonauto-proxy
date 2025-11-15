# Sonauto Proxy — PRO (Option B)

Files included:
- server.js — PRO proxy server with robust polling, keep-alive, optional S3 upload and simple client auth.
- public/index.html — PRO Dashboard UI (tailwind CDN).
- package.json — deps: dotenv, aws-sdk (optional).
- render.yaml — Render service config (free plan).
- .env.example — example env for local testing.
- downloads/ — directory for saved mp3 if AUTO_DOWNLOAD=true.

## Deploy (recommended)
1. Push this repo to GitHub.
2. Create new Web Service on Render and connect repo (branch main).
3. Render detects `render.yaml` and deploys automatically.

## Environment (Render UI > Environment)
Set these:
- EXPO_PUBLIC_SONAUTO_API_KEY = your Sonauto key (secret)
- AUTO_DOWNLOAD = false
- ENABLE_KEEP_ALIVE = true
- KEEP_ALIVE_URL = https://<your-render-service>.onrender.com/
- CLIENT_API_KEY = (optional) a secret to protect /generate
Optional S3:
- AWS_S3_BUCKET, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION

## Local testing
1. Copy .env.example to .env and fill keys.
2. npm install
3. node server.js
4. Open http://localhost:3000

## Notes
- Keep AUTO_DOWNLOAD=false on Render; use S3 for persistence.
- If using CLIENT_API_KEY, add header X-CLIENT-KEY with that value from your React app.
- KEEP_ALIVE_URL should be set to your deployed site URL so the internal pinger keeps the instance warm.

## React Native Example
POST /generate:
{
  "mode":"custom",
  "lyrics":"Jésus tu es mon tout...",
  "tags":["ballad","worship"]
}
Headers: Content-Type: application/json
Optional header: X-CLIENT-KEY: <client key>

Check status:
GET /status/<taskId>

Download via proxy:
GET /download?url=<encodeURIComponent(song_url)>

