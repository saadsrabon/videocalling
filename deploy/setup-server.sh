#!/usr/bin/env bash
# Full videocalling + coturn setup on Ubuntu VPS.
# Run on server: bash deploy/setup-server.sh
set -euo pipefail

REPO_DIR="${REPO_DIR:-$HOME/videocalling}"
REPO_URL="${REPO_URL:-https://github.com/saadsrabon/videocalling.git}"
JWT_SECRET="${JWT_SECRET:-prod-video-jwt-secret-simfree-2026-min-32-chars}"
TURN_SECRET="${TURN_SECRET:-a4e94a0073cd55d7e6644820ce013bfc376ea5ce6d6e03411c4c58d2ca21e221}"
PUBLIC_IP="${PUBLIC_IP:?Set PUBLIC_IP to this video server's public IP (e.g. 147.79.71.98)}"
MEDIASOUP_PORT="${MEDIASOUP_PORT:-40000}"
MEETING_BASE_URL="${MEETING_BASE_URL:-https://admin.simfree.io/meet}"

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
MEDIASOUP_ANNOUNCED_IP=${PUBLIC_IP}
MEDIASOUP_PORT=${MEDIASOUP_PORT}
SFU_MAX_PEERS=10
MEETING_BASE_URL=${MEETING_BASE_URL}
GUEST_JWT_TTL_SECONDS=3600
EOF

echo "==> Open firewall for mediasoup WebRTC (UDP/TCP ${MEDIASOUP_PORT}-40100)"
if command -v ufw >/dev/null 2>&1; then
  sudo ufw allow "${MEDIASOUP_PORT}:40100/udp" || true
  sudo ufw allow "${MEDIASOUP_PORT}:40100/tcp" || true
fi

echo "==> IMPORTANT: AWS EC2 security group must allow inbound UDP+TCP ${MEDIASOUP_PORT}-40100"
echo "    (Signaling uses HTTPS :443; SFU media is direct to ${PUBLIC_IP}:${MEDIASOUP_PORT} — not via Cloudflare.)"
echo "    EC2 console → Security Groups → default → Inbound rules → Add:"
echo "      Custom UDP  ${MEDIASOUP_PORT}-40100  Source 0.0.0.0/0"
echo "      Custom TCP  ${MEDIASOUP_PORT}-40100  Source 0.0.0.0/0"

echo "==> Install coturn"
sudo TURN_SECRET="${TURN_SECRET}" EXTERNAL_IP="${PUBLIC_IP}" bash "$REPO_DIR/scripts/install-coturn-ubuntu.sh"

echo "==> Build videocalling (mediasoup native worker compiles on Linux)"
cd "$REPO_DIR"
# Use npm ci on VPS — pnpm may skip mediasoup postinstall (ERR_PNPM_IGNORED_BUILDS).
npm ci
node scripts/check-mediasoup-worker.mjs
npm run build

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
echo "SFU media uses UDP/TCP ${MEDIASOUP_PORT} direct to ${PUBLIC_IP} (not via Cloudflare)."
