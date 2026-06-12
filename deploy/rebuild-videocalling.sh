#!/usr/bin/env bash
# Lightweight videocalling rebuild — standalone repo only.
# Usage: bash deploy/rebuild-videocalling.sh
set -euo pipefail

ROOT="${VIDEO_ROOT:-$HOME/videocalling}"
cd "$ROOT"

export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=1024}"

echo "==> Pull latest"
git pull --ff-only origin main

echo "==> Install (this repo only)"
npm ci
node scripts/check-mediasoup-worker.mjs

echo "==> Build"
npm run build

echo "==> Restart"
pm2 restart videocalling

echo "==> Health"
sleep 2
curl -sf "http://127.0.0.1:3004/health" && echo ""

echo "Done."
