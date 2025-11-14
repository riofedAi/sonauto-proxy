# Sonauto Proxy (Render-ready) — Dashboard (Option B)

This repository contains a Node.js HTTP proxy to interact with the Sonauto API and a small dashboard UI.

## Files
- `server.js` — main HTTP server and proxy (long-polling, streaming, download proxy, background polling).
- `public/index.html` — Dashboard UI (Option B: dashboard with logs, task status, tracks list).
- `package.json` — minimal Node configuration.
- `render.yaml` — Render service configuration (free plan).
- `.env.example` — example environment variables.

## Deploy to Render (recommended)
1. Push this repo to GitHub (or GitLab).  
2. In Render dashboard click **New → Web Service**.  
3. Connect your repo and select branch `main`. Render will detect `render.yaml` and create the service.
4. In Render service settings > Environment set:
   - `EXPO_PUBLIC_SONAUTO_API_KEY` = (your Sonauto API key) — secret
   - `AUTO_DOWNLOAD` = false
5. Deploy. Render runs `npm install` and `node server.js`.

## Local testing
1. Copy `.env.example` to `.env` and set your key.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Run:
   ```bash
   node server.js
   ```
4. Open `http://localhost:3000`

## Usage (API)
- `POST /generate` body JSON:
  ```json
  { "mode": "custom|prompt|instrumental", ... }
  ```
  Example:
  ```json
  { "mode":"custom", "lyrics":"Hello world", "tags":["pop"] }
  ```

- `GET /status/<taskId>` — returns Sonauto task status response  
- `GET /download?url=<song_url>` — proxies download (no saving required)

## React Native integration
Set your API base to `https://<your-service>.onrender.com` and call `/generate` and `/status/<id>`.

## Notes & recommendations
- Keep `AUTO_DOWNLOAD=false` on Render because filesystem is ephemeral.
- For persistent storage use S3/DigitalOcean Spaces and upload tracks in `handlePolling`.
- Add auth and rate limiting in production.
- If you want, I can add S3 upload example, or a worker service for polling.

## Git + Render quick commands
```bash
# initialize and push to GitHub
git init
git add .
git commit -m "Initial Sonauto proxy"
# create remote repo on GitHub and push (replace URL)
git remote add origin git@github.com:YOURUSER/YOURREPO.git
git branch -M main
git push -u origin main
```

Then connect the repo to Render and follow the Render UI steps above.
