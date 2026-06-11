#!/usr/bin/env bash
# Copy browser SDK sources into simfree-monorepo/packages/video-client.
# Does NOT overwrite package.json (Simfree keeps @simfree/video-client name).
#
# Usage:
#   npm run sync:simfree
#   SIMFREE_ROOT=/path/to/simfree-monorepo bash scripts/sync-sdk-to-simfree.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/packages/client-sdk/src"
SIMFREE_ROOT="${SIMFREE_ROOT:-$ROOT/../simfree-monorepo}"
DEST="$SIMFREE_ROOT/packages/video-client/src"

SDK_FILES=(
  http.ts
  index.ts
  types.ts
  video-client.ts
  staff-call-client.ts
  meeting-client.ts
)

if [[ ! -d "$SRC" ]]; then
  echo "error: SDK source not found: $SRC" >&2
  exit 1
fi

if [[ ! -d "$DEST" ]]; then
  echo "error: Simfree destination not found: $DEST" >&2
  echo "Set SIMFREE_ROOT to your simfree-monorepo checkout." >&2
  exit 1
fi

for file in "${SDK_FILES[@]}"; do
  if [[ ! -f "$SRC/$file" ]]; then
    echo "error: missing source file: $SRC/$file" >&2
    exit 1
  fi
  cp "$SRC/$file" "$DEST/$file"
  echo "synced $file"
done

echo ""
echo "Synced ${#SDK_FILES[@]} files to $DEST"
echo "package.json left unchanged (@simfree/video-client metadata)."
echo ""
echo "Next (in simfree-monorepo):"
echo "  pnpm --filter @simfree/video-client build"
echo "  pnpm --filter admin build"
