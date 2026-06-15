import { Client } from "ssh2";
import { readFileSync } from "node:fs";

const PASSWORD = process.env.VIDEO_SSH_PASSWORD;
if (!PASSWORD) process.exit(1);

function exec(conn, cmd) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let out = "";
      stream.on("data", (d) => (out += d.toString()));
      stream.stderr.on("data", (d) => (out += d.toString()));
      stream.on("close", (code) => resolve({ code, out }));
    });
  });
}

const conn = new Client();
conn.on("ready", () => {
  void (async () => {
    const fixYaml = `
set -e
ENV=/var/www/videocalling/.env
LK=/var/www/videocalling/deploy/livekit/livekit.yaml
API_KEY=$(grep '^LIVEKIT_API_KEY=' "$ENV" | cut -d= -f2-)
API_SECRET=$(grep '^LIVEKIT_API_SECRET=' "$ENV" | cut -d= -f2-)

cat > "$LK" << EOF
port: 7880
log_level: info

rtc:
  tcp_port: 7881
  port_range_start: 50000
  port_range_end: 60000
  use_external_ip: true
  node_ip: 147.79.71.98

redis:
  address: 127.0.0.1:6379

keys:
  \${API_KEY}: \${API_SECRET}

# coturn already binds 3478 on this host — use external TURN or disable embedded TURN
turn:
  enabled: false
EOF

cd /var/www/videocalling/deploy/livekit
docker compose up -d --force-recreate livekit
sleep 4
docker ps --filter name=livekit-livekit
docker logs livekit-livekit-1 --tail 8 2>&1
ss -tlnp | grep -E '7880|7881' || echo 'ports missing'

# Firewall: nginx on app server must reach LiveKit signaling
ufw allow from 3.73.242.203 to any port 7880 proto tcp comment 'livekit signal from admin' 2>/dev/null || true
ufw allow 7881/tcp comment 'livekit rtc tcp' 2>/dev/null || true

curl -s -o /dev/null -w 'local_7880:%{http_code}\\n' http://127.0.0.1:7880/
`;

    const { out } = await exec(conn, fixYaml);
    console.log(out);
    conn.end();
  })();
});
conn.on("error", (e) => {
  console.error(e.message);
  process.exit(1);
});
conn.connect({ host: "147.79.71.98", username: "root", password: PASSWORD });
