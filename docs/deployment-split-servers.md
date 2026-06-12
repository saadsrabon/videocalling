# Deploying app and video backend on separate servers

> Run your **frontend app** on one host and this **video microservice** on another.
>
> **Last updated:** 2026-06-12

---

## Why split servers?

| Concern | App server | Video server (this repo) |
|---------|------------|---------------------------|
| UI, login, business logic | ✅ | ❌ |
| WebRTC signaling, rooms, SFU | ❌ | ✅ |
| Camera/mic, rendering | Browser only | ❌ |
| Media RTP (audio/video bytes) | Never touches app server | Direct browser ↔ P2P/TURN/SFU |

Splitting keeps your main app lightweight: it only calls HTTP/WebSocket APIs and uses the browser SDK. All heavy realtime work stays on the video VPS.

---

## Architecture overview

```text
┌─────────────────────────┐         ┌──────────────────────────────────┐
│  Your app server        │         │  Video server (videocalling)     │
│  e.g. app.yourdomain.com│  HTTP   │  e.g. video-api.yourdomain.com   │
│  React / Next / Vue …   │ ──────► │  Fastify + signaling + mediasoup │
└─────────────────────────┘   WS    └──────────────────────────────────┘
         │                                      │
         │                                      ├── coturn (TURN, often same VPS)
         │                                      └── SFU media UDP/TCP :40000 (direct)
         │
    Your auth API issues JWTs
    (shared secret with video server)
```

### Three traffic types

| Traffic | Path | Proxied? |
|---------|------|----------|
| REST (`/v1/rooms`, `/v1/meetings`, …) | App → video server | Optional (nginx) |
| WebSocket (`/v1/signaling`) | App → video server | Optional; must support upgrade |
| WebRTC media (P2P, TURN, SFU) | Browser → peers or video VPS | **No** — never through app server or CDN |

Signaling is a blind relay. Media never flows through the HTTP API.

---

## Video server setup (separate VPS)

Deploy this repository on its own machine (Linux recommended for mediasoup).

### 1. Install and build

```bash
git clone <your-repo-url> videocalling
cd videocalling
npm ci
node scripts/check-mediasoup-worker.mjs   # must exit 0 — SFU needs the binary
npm run build
```

**Note:** On Linux VPS, prefer **`npm ci`** over `pnpm install`. Recent pnpm versions may skip mediasoup’s `postinstall` (`ERR_PNPM_IGNORED_BUILDS`), leaving no `node_modules/mediasoup/worker/out/Release/mediasoup-worker`.

Or use Docker (`Dockerfile` + `docker-compose.dev.yml` for local SFU testing; adapt for production).

Process manager: `deploy/ecosystem.config.cjs` (PM2) or systemd. See `deploy/setup-server.sh` for a full VPS bootstrap reference.

### 2. Production environment variables

Copy `.env.example` and set at minimum:

```env
NODE_ENV=production
HOST=127.0.0.1
PORT=3004
AUTH_MODE=jwt
JWT_SECRET=<same-secret-as-your-auth-service>

STUN_URLS=stun:stun.l.google.com:19302
TURN_URL=turn:<VPS_PUBLIC_IP>:3478
TURN_SECRET=<coturn-static-auth-secret>
TURN_CREDENTIAL_TTL_SECONDS=3600

MEDIASOUP_ANNOUNCED_IP=<VPS_PUBLIC_IP>
MEDIASOUP_PORT=40000
SFU_MAX_PEERS=6

MEETING_BASE_URL=https://your-app.com/meet
GUEST_JWT_TTL_SECONDS=3600
```

| Variable | Purpose |
|----------|---------|
| `JWT_SECRET` | Must match the service that **signs** video JWTs (e.g. your auth API `VIDEO_JWT_SECRET`) |
| `MEDIASOUP_ANNOUNCED_IP` | **Required in production** — public IP browsers use for SFU ICE |
| `MEETING_BASE_URL` | Your **frontend** URL prefix for guest links (not the video server URL) |
| `TURN_URL` / `TURN_SECRET` | See [`docs/coturn-vps.md`](coturn-vps.md) |

Bind to `127.0.0.1` and put **nginx** (or Caddy) in front for HTTPS on port 443.

### 3. Firewall (video VPS)

| Port | Protocol | Service |
|------|----------|---------|
| 443 | TCP | HTTPS (nginx → video API) |
| 3478 | UDP/TCP | coturn |
| 49152–65535 | UDP | coturn relay range |
| 40000 | UDP/TCP | mediasoup SFU WebRTC |

**Do not** put SFU media (port 40000) behind Cloudflare or a generic HTTP reverse proxy. RTP must reach the VPS directly.

### 4. Verify video server

```bash
curl -s https://video-api.yourdomain.com/health
# {"status":"ok","service":"video-sdk-service"}
```

---

## App server setup (different host)

Your frontend does **not** run mediasoup or Node WebRTC. It uses the browser SDK.

### 1. Install the client SDK

The SDK lives in `packages/client-sdk`. Build and depend on it from your app:

```bash
pnpm run build:sdk
```

```javascript
import { VideoClient, MeetingClient, StaffCallClient } from "@video-sdk/client";
```

Publish or link the package into your monorepo as needed.

### 2. Configure the video API URL

Expose a public base URL to your frontend:

```env
# Next.js example
NEXT_PUBLIC_VIDEO_API=https://video-api.yourdomain.com
```

Use the same value wherever you pass `serverUrl`:

```javascript
await MeetingClient.join({
  serverUrl: process.env.NEXT_PUBLIC_VIDEO_API,
  token: staffJwt,
  code: "AB12CD34",
});
```

The SDK accepts an origin with an optional path prefix (e.g. `https://app.com/video-api`).

### 3. HTTPS (required in production)

Browsers require a **secure context** for `getUserMedia` and WebRTC. Serve your app over HTTPS. `localhost` over HTTP is fine for dev only.

### 4. Pages your app must provide

| Feature | Frontend responsibility |
|---------|-------------------------|
| Login | Your auth UI → issue or fetch video JWT |
| 1:1 calls | `VideoClient` or `StaffCallClient` + video elements |
| Group meetings | `/meet/[code]` route + `MeetingClient` |
| Guest join | Form for name → `MeetingClient.fetchGuestToken` → join |

Set `MEETING_BASE_URL` on the **video server** to match your meeting route, e.g. `https://your-app.com/meet`.

---

## Authentication across servers

Your **auth service** (often on the app server or its own API) signs JWTs. This video service only **validates** them.

```text
User logs in → Auth API → JWT with userId/sub
                         → Frontend stores token
                         → Frontend sends Authorization: Bearer <jwt> to video API
```

| Auth API (your app) | Video server (this repo) |
|---------------------|---------------------------|
| `VIDEO_JWT_SECRET=abc…` | `JWT_SECRET=abc…` (identical) |

Expected JWT claims: stable `userId` or `sub` (see `src/auth/jwt-auth.adapter.ts`). Optional `roles`, `name`, etc. in metadata.

**Guest meetings:** no account needed. Video server issues short-lived guest tokens via:

```http
POST /v1/meetings/:code/guest-token
Content-Type: application/json

{ "name": "Alex Guest" }
```

---

## Connecting app ↔ video API

CORS is enabled with `origin: true` in `src/index.ts`, so **cross-origin** requests from your app domain work out of the box.

### Option A — Direct cross-origin (simplest)

| Service | URL |
|---------|-----|
| App | `https://app.yourdomain.com` |
| Video API | `https://video-api.yourdomain.com` |

Frontend calls the video URL directly for REST and WebSocket.

### Option B — Proxy through app domain (same-origin)

Hide the video API behind your app domain (production Simfree pattern):

| Public URL | Proxies to |
|------------|------------|
| `https://app.yourdomain.com/video-api/` | Video server `http://127.0.0.1:3004/` or remote IP |

Nginx snippet (`deploy/nginx-video-snippet.conf`):

```nginx
upstream video_backend {
    server 127.0.0.1:3004;   # or remote video VPS IP
    keepalive 16;
}

location /video-api/ {
    proxy_pass http://video_backend/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

Frontend env:

```env
NEXT_PUBLIC_VIDEO_API=https://app.yourdomain.com/video-api
```

**Note:** WebSocket upgrade headers are required. SFU media still uses direct UDP/TCP to the video VPS on port 40000.

---

## Feature checklist

| Feature | Video server | App server | Network |
|---------|--------------|------------|---------|
| 1:1 P2P calls | ✅ API + signaling | ✅ SDK + UI | STUN; TURN if NAT is strict |
| Staff call invite | ✅ signaling relay | ✅ `StaffCallClient` | Same as 1:1 |
| SFU meetings (≤6) | ✅ mediasoup + `MEDIASOUP_ANNOUNCED_IP` | ✅ `MeetingClient` + `/meet/[code]` | Open 40000 UDP/TCP on video VPS |
| Guest links | ✅ `MEETING_BASE_URL`, guest-token routes | ✅ guest join page | HTTPS on app |
| Screen share | — | ✅ `MeetingClient.startScreenShare()` | Client-only |
| TURN relay | ✅ creds in `/v1/ice-servers` | — | coturn on VPS |

---

## Deployment order

1. **Video VPS:** deploy this repo, coturn, nginx, open firewall ports.
2. **Auth:** configure your API to sign JWTs with the shared secret.
3. **App host:** deploy frontend with SDK and `NEXT_PUBLIC_VIDEO_API`.
4. **Video `.env`:** set `MEETING_BASE_URL` to your app’s meeting URL.
5. **Smoke test:** two browsers, two users → create meeting → join → confirm audio/video.

---

## Local development (before split deploy)

| Goal | Command |
|------|---------|
| API only (native) | `pnpm dev` or `pnpm dev:lan` |
| SFU on Windows/macOS | `pnpm docker:dev` (see `docker-compose.dev.yml`) |
| Meeting UI test | `pnpm demo:meeting` → `http://127.0.0.1:5000/examples/meeting-demo/` |
| Dev JWT | `pnpm token user-a` or `GET /v1/dev/token?userId=` (development only) |

Docker uses `MEDIASOUP_ANNOUNCED_IP=host.docker.internal` so browsers on the host can reach the SFU.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| 401 on all video endpoints | JWT secret mismatch | Align `JWT_SECRET` ↔ auth `VIDEO_JWT_SECRET` |
| Signaling works, no SFU video | SFU blocked or wrong IP | Set `MEDIASOUP_ANNOUNCED_IP`; open 40000 UDP/TCP |
| Guest link goes to wrong host | `MEETING_BASE_URL` wrong | Point at **app** URL, not video API |
| Camera blocked | HTTP in production | Serve app over HTTPS |
| WebSocket fails behind proxy | Missing upgrade headers | Add `Upgrade` / `Connection` in nginx |
| Same user twice in a call | Duplicate JWT / userId | Use distinct tokens per participant |
| P2P fails, SFU OK | NAT / no TURN | Configure coturn — [`docs/coturn-vps.md`](coturn-vps.md) |

---

## Related docs

| Doc | Topic |
|-----|--------|
| [`docs/frontend-integration.md`](frontend-integration.md) | SDK usage, API reference, WebSocket protocol |
| [`docs/coturn-vps.md`](coturn-vps.md) | TURN server on VPS |
| [`docs/codebase-exploration.md`](codebase-exploration.md) | Repo map and call traces |
| [`deploy/setup-server.sh`](../deploy/setup-server.sh) | Automated VPS bootstrap |
| [`deploy/nginx-video-snippet.conf`](../deploy/nginx-video-snippet.conf) | nginx proxy template |
| [`PLAN.md`](../PLAN.md) | Build phases and architecture decisions |
