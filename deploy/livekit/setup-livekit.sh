#!/usr/bin/env bash
# Install LiveKit (Docker) on the video server alongside videocalling API.
# Usage (on 147.79.71.98):
#   cd /var/www/videocalling && bash deploy/livekit/setup-livekit.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LK_DIR="$ROOT/deploy/livekit"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required. Install Docker first."
  exit 1
fi

if [[ ! -f "$LK_DIR/livekit.yaml" ]]; then
  echo "Missing $LK_DIR/livekit.yaml"
  exit 1
fi

echo "==> Generating LiveKit API keys (save these in videocalling .env)"
docker run --rm livekit/livekit-server generate-keys || true

echo "==> Starting LiveKit + Redis (host networking)"
cd "$LK_DIR"
docker compose pull
docker compose up -d

echo ""
echo "Open firewall on this VPS:"
echo "  TCP 7880  (from app server 3.73.242.203 — nginx upstream)"
echo "  TCP 7881  (WebRTC TCP)"
echo "  UDP 3478  (TURN/UDP)"
echo "  UDP 50000-60000 (WebRTC media)"
echo ""
echo "Add to videocalling .env:"
echo "  MEDIA_BACKEND=both"
echo "  LIVEKIT_URL=wss://admin.simfree.io/livekit"
echo "  LIVEKIT_INTERNAL_URL=http://127.0.0.1:7880"
echo "  LIVEKIT_API_KEY=..."
echo "  LIVEKIT_API_SECRET=..."
