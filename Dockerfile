# Dockerfile — Music AI Proxy + MCIA for Railway
# Build: docker build -t sonauto-proxy .
# Run  : docker run -p 3000:3000 -e EXPO_PUBLIC_SONAUTO_API_KEY=... sonauto-proxy

# ──────────────────────────────────────────────────────────────────────────────
# Stage 1: Builder
# ──────────────────────────────────────────────────────────────────────────────
FROM node:18-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (omit dev dependencies to match render.yaml)
RUN npm install --omit=dev

# Copy application source
COPY . .

# ──────────────────────────────────────────────────────────────────────────────
# Stage 2: Runtime
# ──────────────────────────────────────────────────────────────────────────────
FROM node:18-alpine

WORKDIR /app

# Copy node_modules and app from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app . .

# Expose port (Railway will use PORT env var, default 3000)
EXPOSE 3000

# Health check matching render.yaml
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

# Environment variables (Railway will override via dashboard)
ENV NODE_ENV=production
ENV PORT=3000

# Start command matching render.yaml
CMD ["node", "server.js"]
