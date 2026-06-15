#!/usr/bin/env bash
# Safe code-only update on the VIDEO SERVER — does NOT overwrite .env or JWT_SECRET.
# Usage: cd /var/www/videocalling && bash deploy/quick-update.sh
set -euo pipefail

ROOT="${VIDEO_ROOT:-/var/www/videocalling}"
cd "$ROOT"

export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=1024}"

echo "==> Current commit"
git log -1 --oneline

echo "==> Pull latest"
git pull --ff-only origin main

echo "==> Install + build"
npm ci
node scripts/check-mediasoup-worker.mjs
npm run build

echo "==> Restart"
pm2 restart videocalling || pm2 start deploy/ecosystem.config.cjs
pm2 save

echo "==> Health + env check"
sleep 2
curl -sf "http://127.0.0.1:3004/health" && echo ""
grep -E '^(HOST|MEDIASOUP_ANNOUNCED_IP|PORT)=' .env || true

echo "Done."
