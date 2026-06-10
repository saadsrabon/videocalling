#!/usr/bin/env bash
# Install and configure coturn on Ubuntu VPS for videocalling TURN relay.
# Usage (on VPS as root or with sudo):
#   sudo TURN_SECRET='your-secret-min-16-chars' bash setup-coturn.sh
#
# Optional env:
#   TURN_LISTEN_PORT=3478
#   TURN_MIN_PORT=49152
#   TURN_MAX_PORT=65535
#   TURN_REALM=videocalling.local

set -euo pipefail

TURN_SECRET="${TURN_SECRET:?Set TURN_SECRET (same value as videocalling .env TURN_SECRET)}"
TURN_LISTEN_PORT="${TURN_LISTEN_PORT:-3478}"
TURN_MIN_PORT="${TURN_MIN_PORT:-49152}"
TURN_MAX_PORT="${TURN_MAX_PORT:-65535}"
TURN_REALM="${TURN_REALM:-videocalling.local}"

PUBLIC_IP="$(curl -4 -s ifconfig.me || curl -4 -s icanhazip.com || true)"

if [[ -z "${PUBLIC_IP}" ]]; then
  echo "Could not detect public IP. Set PUBLIC_IP env and re-run." >&2
  exit 1
fi

echo "Detected public IP: ${PUBLIC_IP}"

apt-get update
apt-get install -y coturn ufw curl

sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn

cat > /etc/turnserver.conf <<EOF
listening-port=${TURN_LISTEN_PORT}
fingerprint
lt-cred-mech
use-auth-secret
static-auth-secret=${TURN_SECRET}
realm=${TURN_REALM}

external-ip=${PUBLIC_IP}

min-port=${TURN_MIN_PORT}
max-port=${TURN_MAX_PORT}

total-quota=100
stale-nonce
no-loopback-peers
no-multicast-peers

log-file=/var/log/turnserver.log
simple-log
verbose
EOF

chmod 640 /etc/turnserver.conf

ufw allow "${TURN_LISTEN_PORT}/tcp" || true
ufw allow "${TURN_LISTEN_PORT}/udp" || true
ufw allow "${TURN_MIN_PORT}:${TURN_MAX_PORT}/udp" || true

systemctl enable coturn
systemctl restart coturn

sleep 2

if systemctl is-active --quiet coturn; then
  echo "coturn is running."
else
  echo "coturn failed to start. Check: journalctl -u coturn -n 50" >&2
  exit 1
fi

echo ""
echo "=== Coturn ready ==="
echo "TURN_URL=turn:${PUBLIC_IP}:${TURN_LISTEN_PORT}"
echo "TURN_SECRET=${TURN_SECRET}"
echo ""
echo "Add to videocalling .env and restart the video service."
echo "Cloud security group: open TCP/UDP ${TURN_LISTEN_PORT} and UDP ${TURN_MIN_PORT}-${TURN_MAX_PORT}."
