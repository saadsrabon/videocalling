#!/bin/bash
# Run on Ubuntu VPS as root/sudo — e.g. ssh ubuntu@3.73.242.203
set -euo pipefail

EXTERNAL_IP="${EXTERNAL_IP:-3.73.242.203}"
TURN_SECRET="${TURN_SECRET:?Set TURN_SECRET to match video API .env}"

echo "Installing coturn on ${EXTERNAL_IP}..."

sudo apt-get update
sudo apt-get install -y coturn

sudo tee /etc/turnserver.conf >/dev/null <<EOF
listening-port=3478
fingerprint
lt-cred-mech
use-auth-secret
static-auth-secret=${TURN_SECRET}
realm=videocalling.local
external-ip=${EXTERNAL_IP}
min-port=49152
max-port=65535
total-quota=100
stale-nonce
no-loopback-peers
no-multicast-peers
log-file=/var/log/turnserver.log
simple-log
EOF

sudo sed -i 's/#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/' /etc/default/coturn 2>/dev/null || true
grep -q 'TURNSERVER_ENABLED=1' /etc/default/coturn || echo 'TURNSERVER_ENABLED=1' | sudo tee -a /etc/default/coturn

if command -v ufw >/dev/null 2>&1; then
  sudo ufw allow 3478/tcp
  sudo ufw allow 3478/udp
  sudo ufw allow 49152:65535/udp
fi

sudo systemctl enable coturn
sudo systemctl restart coturn
sudo systemctl status coturn --no-pager

echo "Done. Open AWS Security Group: UDP/TCP 3478, UDP 49152-65535"
