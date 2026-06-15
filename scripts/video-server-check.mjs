import { Client } from "ssh2";

const PASSWORD = process.env.VIDEO_SSH_PASSWORD;
if (!PASSWORD) {
  console.error("Set VIDEO_SSH_PASSWORD");
  process.exit(1);
}

function exec(conn, cmd) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let out = "";
      stream.on("data", (d) => (out += d.toString()));
      stream.stderr.on("data", (d) => (out += d.toString()));
      stream.on("close", () => resolve(out));
    });
  });
}

const conn = new Client();
conn.on("ready", () => {
  void (async () => {
    const cmd = `
cd /var/www/videocalling 2>/dev/null || { echo "REPO_NOT_FOUND"; exit 1; }
echo "=== git ==="
git branch -a 2>/dev/null | head -10
echo "current: $(git branch --show-current 2>/dev/null)"
echo "HEAD: $(git log -1 --oneline 2>/dev/null)"
echo "livekitv2: $(git log -1 --oneline livekitv2 2>/dev/null || echo 'branch missing')"
echo "=== pm2 videocalling ==="
pm2 describe videocalling 2>/dev/null | grep -E 'status|version|exec cwd|restarts' || pm2 list | grep videocalling
echo "=== livekit ==="
docker ps --filter name=livekit --format '{{.Names}} {{.Status}}' 2>/dev/null
ss -tlnp | grep 7880 || echo '7880 not listening'
echo "=== env ==="
grep -E '^MEDIA_BACKEND|^LIVEKIT|^PORT|^HOST' .env 2>/dev/null | sed 's/SECRET=.*/SECRET=***/'
echo "=== health ==="
curl -s -m 3 http://127.0.0.1:3004/health 2>/dev/null || echo 'api down'
curl -s -m 3 http://127.0.0.1:3004/v1/livekit/config 2>/dev/null || echo 'no livekit config route'
`;
    console.log(await exec(conn, cmd));
    conn.end();
  })();
});
conn.on("error", (e) => {
  console.error("SSH:", e.message);
  process.exit(1);
});
conn.connect({ host: "147.79.71.98", username: "root", password: PASSWORD });
