# Coturn TURN server on a VPS

Use this when P2P/WebRTC fails (strict NAT, corporate networks). Your video API issues **time-limited TURN credentials**; coturn validates them with the same shared secret.

## Architecture

```text
Browser  ──GET /v1/ice-servers──►  Video API (generates username/credential)
Browser  ──TURN relay (UDP)────►  VPS running coturn
Browser  ◄──media relay────────►  Browser (when P2P fails)
```

## 1. VPS requirements

| Item | Recommendation |
|------|----------------|
| OS | Ubuntu 22.04+ |
| RAM | 1 GB+ (bandwidth matters more than CPU) |
| Ports | UDP/TCP **3478**, UDP relay range **49152–65535** |
| Public IP | Required |

## 2. Install coturn (automated)

From your **local machine**, copy the script to the VPS and run it (replace the secret with your `TURN_SECRET` from videocalling `.env`):

```bash
scp deploy/setup-coturn.sh ubuntu@3.73.242.203:/tmp/
ssh ubuntu@3.73.242.203 'sudo TURN_SECRET="YOUR_TURN_SECRET" bash /tmp/setup-coturn.sh'
```

Or on the VPS directly after cloning this repo:

```bash
sudo TURN_SECRET="YOUR_TURN_SECRET" bash deploy/setup-coturn.sh
```

The script installs coturn, opens UFW ports, detects the public IP, and writes `/etc/turnserver.conf`.

## 3. Manual install (alternative)

```bash
sudo apt update
sudo apt install -y coturn
sudo systemctl enable coturn
```

## 4. Manual configure coturn

Edit `/etc/turnserver.conf` (or copy from `deploy/coturn.turnserver.conf` in this repo).

**Critical settings:**

```conf
listening-port=3478
fingerprint
lt-cred-mech
use-auth-secret
static-auth-secret=YOUR_TURN_SECRET_SAME_AS_VIDEO_API
realm=videocalling.local
total-quota=100
stale-nonce
no-loopback-peers
no-multicast-peers

external-ip=YOUR_VPS_PUBLIC_IP

min-port=49152
max-port=65535
```

Enable coturn:

```bash
sudo sed -i 's/#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/' /etc/default/coturn
sudo systemctl restart coturn
```

## 5. Firewall

```bash
sudo ufw allow 3478/tcp
sudo ufw allow 3478/udp
sudo ufw allow 49152:65535/udp
sudo ufw reload
```

Also open these in your cloud **security group**.

## 6. Video API `.env`

Use the **same** secret as coturn `static-auth-secret`:

```env
TURN_URL=turn:YOUR_VPS_PUBLIC_IP:3478
TURN_SECRET=YOUR_TURN_SECRET_SAME_AS_VIDEO_API
TURN_CREDENTIAL_TTL_SECONDS=3600
```

Restart the API after changing env.

## 7. Verify

**API:**

```bash
curl -sk -H "Authorization: Bearer <JWT>" https://YOUR_API/v1/ice-servers
```

Expected when TURN is configured:

```json
{
  "iceServers": [
    { "urls": "stun:stun.l.google.com:19302" },
    {
      "urls": "turn:YOUR_VPS_IP:3478",
      "username": "1710000000:user-a",
      "credential": "..."
    }
  ]
}
```

**Browser:** DevTools → WebRTC → ICE candidates → look for type **`relay`**.

**Logs:**

```bash
sudo tail -f /var/log/turnserver.log
```

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| No `relay` candidates | Check `TURN_URL`, firewall UDP 49152–65535 |
| TURN auth fails | `TURN_SECRET` must match coturn `static-auth-secret` |
| High bandwidth | TURN relays all media — use dedicated VPS |
