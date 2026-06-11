import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const releaseDir = join(root, "node_modules", "mediasoup", "worker", "out", "Release");
const workerNames =
  process.platform === "win32"
    ? ["mediasoup-worker.exe", "mediasoup-worker"]
    : ["mediasoup-worker"];

const found = workerNames.some((name) => existsSync(join(releaseDir, name)));

if (found) {
  process.exit(0);
}

console.error(`
mediasoup worker binary is missing — SFU cannot start on native Windows.

This usually happens after "npm install --ignore-scripts".

Use Docker (recommended on Windows):
  npm run docker:dev

Then in another terminal:
  npm run demo:meeting
  Open http://127.0.0.1:5000/examples/meeting-demo/

Or rebuild natively (needs Python 3 + Visual Studio Build Tools):
  npm rebuild mediasoup
`);

process.exit(1);
