import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import selfsigned from "selfsigned";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const certDir = join(rootDir, "certs");
const keyPath = join(certDir, "dev-key.pem");
const certPath = join(certDir, "dev-cert.pem");

const lanIp = process.argv[2] ?? process.env.LAN_IP ?? "192.168.1.142";

mkdirSync(certDir, { recursive: true });

const attrs = [{ name: "commonName", value: "videocalling-dev" }];

const extensions = [
  {
    name: "subjectAltName",
    altNames: [
      { type: 2, value: "localhost" },
      { type: 7, ip: "127.0.0.1" },
      { type: 7, ip: lanIp },
    ],
  },
];

const pems = await selfsigned.generate(attrs, {
  days: 365,
  keySize: 2048,
  algorithm: "sha256",
  extensions,
});

writeFileSync(keyPath, pems.private, { mode: 0o600 });
writeFileSync(certPath, pems.cert);

console.log(`Generated dev TLS cert for LAN IP ${lanIp}`);
console.log(`  key:  ${keyPath}`);
console.log(`  cert: ${certPath}`);

if (!existsSync(keyPath) || !existsSync(certPath)) {
  process.exit(1);
}
