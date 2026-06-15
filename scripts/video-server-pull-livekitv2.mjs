import { Client } from "ssh2";

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
    const cmd = `
set -e
cd /var/www/videocalling

echo "=== stash local deploy edits ==="
git stash push -m "prod-livekit-yaml" -- deploy/livekit/livekit.yaml pnpm-lock.yaml 2>/dev/null || true

echo "=== pull livekitv2 ==="
git fetch origin livekitv2
git checkout livekitv2
git pull origin livekitv2
echo "HEAD: $(git log -1 --oneline)"

echo "=== restore production livekit.yaml (keys from .env, turn off — coturn uses 3478) ==="
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

turn:
  enabled: false
EOF

cd deploy/livekit
docker compose up -d --force-recreate livekit
sleep 3

cd /var/www/videocalling
echo "=== npm build ==="
npm ci
npm run build
pm2 restart videocalling
sleep 2

echo "=== verify ==="
git log -1 --oneline
curl -s http://127.0.0.1:3004/health; echo
curl -s http://127.0.0.1:3004/v1/livekit/config; echo
docker ps --filter name=livekit-livekit --format '{{.Names}} {{.Status}}'
ss -tlnp | grep 7880 || echo '7880 down'
`;
    const { code, out } = await exec(conn, cmd);
    console.log(out);
    if (code !== 0) process.exit(code);
    conn.end();
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
});
conn.on("error", (e) => {
  console.error("SSH:", e.message);
  process.exit(1);
});
conn.connect({ host: "147.79.71.98", username: "root", password: PASSWORD });
