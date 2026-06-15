#!/usr/bin/env bash
# Run ON THE VIDEO SERVER (147.79.71.98), NOT on the admin/app server.
#   ssh root@147.79.71.98
#   cd /var/www/videocalling && bash deploy/fix-video-server-env.sh
set -euo pipefail

ROOT="${VIDEO_ROOT:-/var/www/videocalling}"
PUBLIC_IP="${PUBLIC_IP:-147.79.71.98}"
JWT_SECRET="${JWT_SECRET:-dev-video-jwt-secret-change-me-min-32-chars}"
TURN_SECRET="${TURN_SECRET:-a4e94a0073cd55d7e6644820ce013bfc376ea5ce6d6e03411c4c58d2ca21e221}"

cd "$ROOT"

echo "==> Writing .env for video server ${PUBLIC_IP}"
cat > "$ROOT/.env" <<EOF
PORT=3004
HOST=0.0.0.0
NODE_ENV=production
AUTH_MODE=jwt
JWT_SECRET=${JWT_SECRET}
STUN_URLS=stun:stun.l.google.com:19302
USE_HTTPS=false
TURN_URL=turn:${PUBLIC_IP}:3478
TURN_SECRET=${TURN_SECRET}
TURN_CREDENTIAL_TTL_SECONDS=3600
MEDIASOUP_ANNOUNCED_IP=${PUBLIC_IP}
MEDIASOUP_PORT=40000
SFU_MAX_PEERS=10
MEETING_BASE_URL=https://admin.simfree.io/meet
GUEST_JWT_TTL_SECONDS=3600
EOF

echo "==> Allow app server nginx to reach API port 3004 (adjust APP_SERVER_IP if needed)"
APP_SERVER_IP="${APP_SERVER_IP:-3.73.242.203}"
MEDIASOUP_PORT="${MEDIASOUP_PORT:-40000}"
if command -v ufw >/dev/null 2>&1; then
  ufw allow from "${APP_SERVER_IP}" to any port 3004 proto tcp comment 'simfree admin proxy' || true
  ufw allow "${MEDIASOUP_PORT}:40100/udp" || true
  ufw allow "${MEDIASOUP_PORT}:40100/tcp" || true
fi

echo "==> Pull, build, restart"
git pull --ff-only origin main
npm ci
node scripts/check-mediasoup-worker.mjs
npm run build
pm2 restart videocalling || pm2 start deploy/ecosystem.config.cjs
pm2 save

echo "==> Health"
sleep 2
curl -sf "http://127.0.0.1:3004/health" && echo ""

echo ""
echo "Done. Ensure AWS/security group on ${PUBLIC_IP} allows:"
echo "  UDP+TCP 40000-40100 (SFU media)"
echo "  UDP+TCP 3478 (TURN, if coturn installed)"
