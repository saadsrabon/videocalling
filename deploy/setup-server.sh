#!/usr/bin/env bash
# Full videocalling + coturn setup on Ubuntu VPS.
# Run on server: bash deploy/setup-server.sh
set -euo pipefail

REPO_DIR="${REPO_DIR:-$HOME/videocalling}"
REPO_URL="${REPO_URL:-https://github.com/saadsrabon/videocalling.git}"
JWT_SECRET="${JWT_SECRET:-prod-video-jwt-secret-simfree-2026-min-32-chars}"
TURN_SECRET="${TURN_SECRET:-a4e94a0073cd55d7e6644820ce013bfc376ea5ce6d6e03411c4c58d2ca21e221}"
PUBLIC_IP="${PUBLIC_IP:-3.73.242.203}"

echo "==> Clone or update repo"
if [[ -d "$REPO_DIR/.git" ]]; then
  git -C "$REPO_DIR" pull --ff-only origin main
else
  git clone "$REPO_URL" "$REPO_DIR"
fi

echo "==> Write .env"
cat > "$REPO_DIR/.env" <<EOF
PORT=3004
HOST=127.0.0.1
NODE_ENV=production
AUTH_MODE=jwt
JWT_SECRET=${JWT_SECRET}
STUN_URLS=stun:stun.l.google.com:19302
USE_HTTPS=false
TURN_URL=turn:${PUBLIC_IP}:3478
TURN_SECRET=${TURN_SECRET}
TURN_CREDENTIAL_TTL_SECONDS=3600
EOF

echo "==> Install coturn"
sudo TURN_SECRET="${TURN_SECRET}" EXTERNAL_IP="${PUBLIC_IP}" bash "$REPO_DIR/scripts/install-coturn-ubuntu.sh"

echo "==> Build videocalling"
cd "$REPO_DIR"
corepack enable 2>/dev/null || true
pnpm install --frozen-lockfile
pnpm run build

echo "==> PM2"
pm2 delete videocalling 2>/dev/null || true
pm2 start "$REPO_DIR/deploy/ecosystem.config.cjs"
pm2 save

echo "==> Health check"
sleep 2
curl -sf "http://127.0.0.1:3004/health" && echo ""

echo "==> Add VIDEO_JWT to simfree API .env (if missing)"
API_ENV="$HOME/simfree-monorepo/apps/api/.env"
if [[ -f "$API_ENV" ]]; then
  grep -q '^VIDEO_JWT_SECRET=' "$API_ENV" || echo "VIDEO_JWT_SECRET=${JWT_SECRET}" >> "$API_ENV"
  grep -q '^VIDEO_JWT_TTL_SECONDS=' "$API_ENV" || echo "VIDEO_JWT_TTL_SECONDS=3600" >> "$API_ENV"
fi

echo "Done. Configure nginx /video-api/ proxy to 127.0.0.1:3004 (see deploy/nginx-video-snippet.conf)."
