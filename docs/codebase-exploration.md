# Codebase Exploration Guide

> Learn this project by reading files in a deliberate order — from bootstrap to WebRTC demo.
>
> **Last updated:** 2026-06-15

---

## How to use this guide

You do **not** need to read every file at once. Pick one path:

| Goal | Start here |
|------|------------|
| Understand the big picture | [Architecture at a glance](#architecture-at-a-glance) |
| Follow a video call end-to-end | [Trace a 1:1 call](#trace-a-11-call-file-by-file) |
| Follow a group meeting (SFU) | [Trace an SFU meeting](#trace-an-sfu-meeting) |
| Learn backend module by module | [Recommended reading order](#recommended-reading-order) |
| Learn the browser client | [Client SDK path](#client-sdk-path) |
| Run and poke the system | [Hands-on exploration](#hands-on-exploration) |
| Integrate from another app | [`docs/frontend-integration.md`](frontend-integration.md) |

**Tip:** Keep `PLAN.md` open — it explains *why* each phase exists. This guide explains *where* the code lives and *how* pieces connect.

---

## Repository map

```
videocalling/
├── src/                      # Backend microservice (Fastify + TypeScript)
│   ├── index.ts              # Entry point — wires plugins & routes only
│   ├── config/               # Environment + ICE/TURN config (no business logic)
│   ├── auth/                 # Pluggable auth adapters (JWT, session)
│   ├── plugins/              # Fastify plugins (auth, rooms, signaling)
│   ├── routes/               # Thin HTTP handlers
│   ├── rooms/                # Room domain + in-memory store (+ meeting codes)
│   ├── sfu/                  # mediasoup worker, router, transports (group calls)
│   ├── signaling/            # WebSocket relay (join, SDP, ICE, sfu.*)
│   └── turn/                 # TURN credential generation (coturn HMAC)
│
├── packages/client-sdk/      # Browser SDK (VideoClient, StaffCallClient, MeetingClient)
├── examples/
│   ├── demo/                 # 1:1 VideoClient reference UI
│   └── meeting-demo/         # SFU MeetingClient reference UI (up to 6)
├── docs/                     # Guides (you are here)
├── scripts/                  # Dev helpers (token, cert, TURN secret)
├── deploy/                   # VPS scripts, nginx snippet, PM2 config
├── certs/                    # Dev HTTPS certs (generated, gitignored)
├── PLAN.md                   # Build plan — phases, why, verify steps
├── .env.example              # All env vars documented
└── package.json              # Scripts: dev, build, demo, token
```

### What lives where

| Folder | Responsibility | Should import from |
|--------|----------------|-------------------|
| `src/index.ts` | Bootstrap only | plugins, routes, config |
| `src/config/` | Read env, build ICE config | `turn/` for creds only |
| `src/auth/` | `AuthAdapter` interface + impls | nothing in signaling/rooms |
| `src/rooms/` | Room create/join logic | own types + store interface |
| `src/signaling/` | WS message routing + relay | auth types, room service |
| `src/routes/` | HTTP → delegate to services | plugins, services |
| `src/plugins/` | Register Fastify features | everything above |
| `packages/client-sdk/` | Browser HTTP + WS + WebRTC | backend API over network only |

**Rule of thumb:** Domain code (`auth/`, `rooms/`, `signaling/`) never imports from `routes/`. Routes stay thin.

---

## Architecture at a glance

```
                    ┌─────────────────────────────────────┐
                    │           src/index.ts              │
                    │  createAuthAdapter → register all   │
                    └─────────────────────────────────────┘
                                        │
        ┌───────────────────────────────┼───────────────────────────────┐
        ▼                               ▼                               ▼
  auth.plugin                    rooms.plugin                   signaling.plugin
  (AuthAdapter)                  (RoomService)                  (ConnectionRegistry + WS)
        │                               │                               │
        ▼                               ▼                               ▼
  routes/me, rooms,              room-store (memory)              handlers: join, sdp,
  ice-servers, dev-token                                              ice-candidate
        │                               │                               │
        └───────────────────────────────┴───────────────────────────────┘
                                        │
                              Browser / VideoClient
                              (HTTP + WebSocket + WebRTC)
```

Three parallel concerns:

1. **Auth** — who is this user? (JWT or session)
2. **Rooms** — which call session are they in? (HTTP state)
3. **Signaling** — relay SDP/ICE between peers (WebSocket, blind relay)

Media (audio/video) never touches the server.

---

## Recommended reading order

Read in this sequence the first time through. Each step builds on the previous one.

### Step 0 — Orientation (15 min)

| Order | File | What you'll learn |
|-------|------|-------------------|
| 1 | `PLAN.md` (top + progress tracker) | Project goals, phases, decisions |
| 2 | `package.json` | Available scripts (`dev`, `demo:https`, `token`) |
| 3 | `.env.example` | Every config knob |
| 4 | `src/index.ts` | How the server boots and registers modules |

**Question to answer:** *What gets registered, and in what order?*

<details>
<summary>Answer</summary>

`createAuthAdapter` → (dev: CORS + dev-token routes) → `authPlugin` → `roomsPlugin` → HTTP routes → `signalingPlugin` → `listen()`.

Signaling depends on auth + rooms (`dependencies` in `signaling.plugin.ts`).
</details>

---

### Step 1 — Config layer (10 min)

| Order | File | What you'll learn |
|-------|------|-------------------|
| 1 | `src/config/env.ts` | Parsing/validation of all env vars |
| 2 | `src/config/ice.ts` | STUN URL list builder |
| 3 | `src/config/ice-service.ts` | Merges STUN + time-limited TURN creds |
| 4 | `src/turn/credentials.ts` | HMAC username/password for coturn |

**Question to answer:** *When does the API return TURN servers to the client?*

<details>
<summary>Answer</summary>

When `TURN_URL` and `TURN_SECRET` are set in env. `buildClientIceConfig()` calls `generateTurnCredentials()` per request/user.
</details>

---

### Step 2 — Auth (20 min)

| Order | File | What you'll learn |
|-------|------|-------------------|
| 1 | `src/auth/auth-adapter.interface.ts` | Swappable auth contract |
| 2 | `src/auth/types.ts` | `AuthUser`, credentials, results |
| 3 | `src/auth/jwt-auth.adapter.ts` | JWT verify → `userId` from `userId` or `sub` |
| 4 | `src/auth/session-auth.adapter.ts` | External session lookup (stub pattern) |
| 5 | `src/auth/create-auth-adapter.ts` | Factory: `AUTH_MODE` picks adapter |
| 6 | `src/plugins/auth.plugin.ts` | `requireAuth` preHandler for HTTP |
| 7 | `src/routes/me.ts` | Smallest protected route (sanity check) |
| 8 | `src/routes/dev-token.ts` | Dev-only JWT minting |

**Question to answer:** *How does a route get `request.user`?*

<details>
<summary>Answer</summary>

Route uses `preHandler: requireAuth`. That calls `app.authAdapter.authenticate()` with Bearer token or session cookie, then sets `request.user`.
</details>

---

### Step 3 — Rooms (15 min)

| Order | File | What you'll learn |
|-------|------|-------------------|
| 1 | `src/rooms/types.ts` | `Room`, `RoomStore` interface, `RoomError` |
| 2 | `src/rooms/room-store.ts` | In-memory `Map` implementation |
| 3 | `src/rooms/room-service.ts` | `create()`, `join()`, participant checks |
| 4 | `src/plugins/rooms.plugin.ts` | Wires store → service on Fastify |
| 5 | `src/routes/rooms.ts` | `POST /v1/rooms`, `POST /v1/rooms/:id/join` |

**Question to answer:** *Why must HTTP join happen before WebSocket join?*

<details>
<summary>Answer</summary>

Signaling `handleJoin` checks `roomService.isParticipant()`. Without HTTP join, WS returns error `not_in_room`. This keeps room membership authoritative on the server.
</details>

---

### Step 4 — Signaling (25 min)

| Order | File | What you'll learn |
|-------|------|-------------------|
| 1 | `src/signaling/message-types.ts` | All WS message shapes + `parseClientMessage` |
| 2 | `src/signaling/auth.ts` | WS auth via query `token` or `sessionId` |
| 3 | `src/signaling/connection-registry.ts` | Maps `userId` → socket + room |
| 4 | `src/plugins/signaling.plugin.ts` | WS endpoint `/v1/signaling` lifecycle |
| 5 | `src/signaling/router.ts` | Dispatches by `message.type` |
| 6 | `src/signaling/handlers/join.ts` | Bind room, notify peers |
| 7 | `src/signaling/handlers/sdp.ts` | Blind relay offer/answer |
| 8 | `src/signaling/handlers/ice-candidate.ts` | Blind relay ICE |

**Question to answer:** *Does the server parse SDP or media?*

<details>
<summary>Answer</summary>

No. SDP and ICE are opaque strings/objects relayed to `message.to`. Peers run WebRTC in the browser.
</details>

---

### Step 5 — ICE HTTP route (5 min)

| Order | File | What you'll learn |
|-------|------|-------------------|
| 1 | `src/routes/ice-servers.ts` | `GET /v1/ice-servers` → `buildClientIceConfig` |
| 2 | `src/routes/health.ts` | Simple health check |

---

### Step 6 — Client SDK path (30 min)

| Order | File | What you'll learn |
|-------|------|-------------------|
| 1 | `packages/client-sdk/src/types.ts` | Public types + events |
| 2 | `packages/client-sdk/src/http.ts` | Token/URL normalization, auth headers |
| 3 | `packages/client-sdk/src/video-client.ts` | Full call flow: HTTP → WS → WebRTC |
| 4 | `packages/client-sdk/src/index.ts` | Public exports |
| 5 | `examples/demo/app.js` | How a UI uses `VideoClient` |
| 6 | `examples/demo/index.html` | Demo layout + controls |

**Question to answer:** *What does `VideoClient.connect()` do internally, in order?*

<details>
<summary>Answer</summary>

1. `GET /v1/ice-servers`
2. `POST /v1/rooms` (if no `roomId`) or skip
3. `POST /v1/rooms/:id/join`
4. `getUserMedia()` for camera/mic
5. Open WebSocket → wait for `connected` → send `join`
6. On `joined`, create offers to existing participants; handle offer/answer/ICE
</details>

---

### Step 7 — Ops & TURN (optional)

| Order | File | What you'll learn |
|-------|------|-------------------|
| 1 | `docs/coturn-vps.md` | VPS TURN setup |
| 2 | `deploy/coturn.turnserver.conf` | coturn config template |
| 3 | `scripts/install-coturn-ubuntu.sh` | Automated install |
| 4 | `scripts/generate-token.mjs` | CLI dev JWT |
| 5 | `scripts/generate-dev-cert.mjs` | LAN HTTPS certs |

---

## Trace a 1:1 call (file by file)

Follow this path while reading code — it mirrors runtime order.

### Phase A — User A (host) connects

```
Browser (demo or your app)
  │
  ├─ scripts/generate-token.mjs  OR  GET /v1/dev/token
  │     └─ src/routes/dev-token.ts
  │
  ├─ GET /v1/ice-servers
  │     └─ src/routes/ice-servers.ts
  │           └─ src/config/ice-service.ts → src/turn/credentials.ts
  │
  ├─ POST /v1/rooms
  │     └─ src/routes/rooms.ts → src/rooms/room-service.ts → room-store.ts
  │
  ├─ POST /v1/rooms/:roomId/join
  │     └─ same chain; adds userId to room.participants
  │
  └─ WS /v1/signaling?token=...
        └─ src/plugins/signaling.plugin.ts
              ├─ src/signaling/auth.ts (validate JWT)
              ├─ connection-registry.register()
              ├─ send "connected"
              └─ client sends "join"
                    └─ src/signaling/handlers/join.ts
                          └─ registry.bindRoom(), send "joined"
```

### Phase B — User B (guest) joins same room

Same HTTP + WS path, but:

- Skips `POST /v1/rooms` (uses shared `roomId`)
- `join.ts` includes User A in `participants` → User B's client creates offers
- User A receives `peer-joined` via `join.ts` loop

### Phase C — WebRTC negotiation

```
packages/client-sdk/src/video-client.ts
  │
  ├─ createOffer → WS { type: "offer", to, sdp }
  │     └─ router.ts → handlers/sdp.ts → registry.sendToUser(peer)
  │
  ├─ peer handleOffer → answer → WS { type: "answer" }
  │     └─ same sdp.ts relay path
  │
  └─ onicecandidate → WS { type: "ice-candidate" }
        └─ handlers/ice-candidate.ts → relay to peer

Media flows browser ↔ browser (or via TURN on VPS — not through API)
```

---

## Module reference (every backend file)

Quick lookup table when you know *what* you want but not *where* it is.

### `src/config/`

| File | Role |
|------|------|
| `env.ts` | Load `.env`, validate, export `config` object |
| `ice.ts` | Build STUN-only ICE config from URL list |
| `ice-service.ts` | STUN + optional TURN creds for clients |

### `src/auth/`

| File | Role |
|------|------|
| `auth-adapter.interface.ts` | `AuthAdapter` interface |
| `types.ts` | Shared auth types |
| `jwt-auth.adapter.ts` | HS256 JWT validation |
| `session-auth.adapter.ts` | Session cookie → external auth |
| `create-auth-adapter.ts` | Factory from `AUTH_MODE` |

### `src/rooms/`

| File | Role |
|------|------|
| `types.ts` | `Room`, `RoomStore`, errors |
| `room-store.ts` | In-memory store (`Map`) |
| `room-service.ts` | Business logic: create, join, list, meeting codes |

### `src/sfu/`

| File | Role |
|------|------|
| `worker.ts` | Start mediasoup Worker + WebRtcServer |
| `sfu-service.ts` | Per-room Router, transports, producers, consumers |
| `media-codecs.ts` | Opus + VP8/VP9/H264 codec list |
| `types.ts` | SFU peer/room types + errors |

### `src/signaling/`

| File | Role |
|------|------|
| `message-types.ts` | Protocol types + JSON helpers |
| `auth.ts` | Authenticate WS connection |
| `connection-registry.ts` | userId ↔ socket ↔ roomId |
| `router.ts` | Message dispatch switch |
| `handlers/join.ts` | Room binding + participant notify |
| `handlers/sdp.ts` | Offer/answer relay + validation |
| `handlers/ice-candidate.ts` | ICE relay + validation |
| `handlers/sfu.ts` | SFU signaling (`sfu.*` messages) |
| `handlers/lobby.ts` | Host admit/deny waiting room (`lobby.*`) |
| `handlers/meeting-chat.ts` | In-meeting chat relay (`meeting.chat.*`) |
| `handlers/call.ts` | Staff 1:1 call invite relay |

---

## Trace an SFU meeting

1. Staff `POST /v1/meetings` → [`src/routes/meetings.ts`](../src/routes/meetings.ts) → `RoomService.createMeeting` (mode `sfu`, 8-char code, optional `durationMinutes` → `expiresAt`).
2. Guest `POST /v1/meetings/:code/guest-token` → short-lived JWT with `role: guest` + `roomId`.
3. Client `POST /v1/meetings/:code/join` (staff) or `guest-join` (guest) → HTTP join returns `status: admitted | waiting` + roster.
4. WS `join { roomId }` → [`handlers/join.ts`](../src/signaling/handlers/join.ts) — waiting users get `lobby.waiting`; admitted users enter SFU via `sfuService.joinPeer`.
5. Host `lobby.admit` → [`handlers/lobby.ts`](../src/signaling/handlers/lobby.ts) → waiter gets `lobby.admitted` then starts mediasoup.
6. Client sends `sfu.getRtpCapabilities` → `sfu.createTransport` (send + recv) → `sfu.produce` / `sfu.consume`. On transport `disconnected`/`failed`, client calls `sfu.restartIce` before full reconnect.
7. Chat: `meeting.chat.send` → [`handlers/meeting-chat.ts`](../src/signaling/handlers/meeting-chat.ts) → broadcast `meeting.chat`. Client keeps in-memory history and replays on reconnect.
8. Expiry: [`src/rooms/meeting-expiry.ts`](../src/rooms/meeting-expiry.ts) polls every 15s → `meeting.ended` + `SfuService.closeRoom` + room delete.
8. RTP flows UDP/TCP to mediasoup on `MEDIASOUP_PORT` (not through nginx).
9. On disconnect → `handlePeerDisconnect` → `sfuService.removePeer` → `sfu.peerLeft` broadcast.

Client: [`packages/client-sdk/src/meeting-client.ts`](../packages/client-sdk/src/meeting-client.ts) · Simfree UI: `MeetingRoom.tsx`, `MeetingLobbyPanel.tsx`, `MeetingChatPanel.tsx`, `MeetingVideoGrid.tsx`.

### `src/routes/`

| File | Route |
|------|-------|
| `health.ts` | `GET /health` |
| `dev-token.ts` | `GET /v1/dev/token` (dev only) |
| `me.ts` | `GET /v1/me` |
| `ice-servers.ts` | `GET /v1/ice-servers` |
| `rooms.ts` | `POST /v1/rooms`, `POST /v1/rooms/:id/join` |

### `src/plugins/`

| File | Role |
|------|------|
| `auth.plugin.ts` | Decorate `authAdapter`, export `requireAuth` |
| `rooms.plugin.ts` | Decorate `roomService` |
| `signaling.plugin.ts` | WebSocket route + registry |

### `src/turn/`

| File | Role |
|------|------|
| `credentials.ts` | coturn time-limited username/password |

---

## Client SDK path

```
packages/client-sdk/
├── src/types.ts          # VideoClientConnectOptions, events
├── src/http.ts           # normalizeToken, authHeaders, jsonPostInit
├── src/video-client.ts   # VideoClient class — main logic
└── src/index.ts          # re-exports
```

Build output: `packages/client-sdk/dist/` (import target for demo).

Key class: **`VideoClient`** — static `connect()` runs the full pipeline; instance methods handle mute/hangup/events.

---

## Hands-on exploration

### 1. Start the stack

```bash
# Terminal 1 — API (LAN + HTTPS for camera on other devices)
pnpm dev:lan:https

# Terminal 2 — demo UI
npm run demo:https

# Terminal 3 — generate tokens
pnpm token user-a
pnpm token user-b
```

### 2. Set breakpoints (if using a debugger)

Good first breakpoints:

| File | Line area | When it hits |
|------|-----------|--------------|
| `src/routes/rooms.ts` | POST handlers | Room create/join |
| `src/signaling/handlers/join.ts` | `handleJoin` | WS room join |
| `src/signaling/handlers/sdp.ts` | `relaySdp` | Offer/answer relay |
| `packages/client-sdk/src/video-client.ts` | `connect()` | Client pipeline |

### 3. curl the HTTP API

```bash
TOKEN=$(pnpm token user-a 2>/dev/null | tail -1)

curl -s http://127.0.0.1:3004/health

curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3004/v1/me

curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3004/v1/ice-servers

curl -s -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{}' \
  http://127.0.0.1:3004/v1/rooms
```

### 4. Search the codebase yourself

| Looking for… | Search command / pattern |
|--------------|--------------------------|
| All routes | `rg "app\.(get\|post)" src/routes` |
| Auth usage | `rg "requireAuth" src/` |
| WS message types | `src/signaling/message-types.ts` |
| Error codes | `rg "code:" src/signaling` |
| Fastify decorators | `rg "decorate\(" src/plugins` |
| Env vars | `.env.example` + `src/config/env.ts` |

### 5. Verify types compile

```bash
pnpm typecheck:all
```

---

## Layer rules (read before changing code)

From `.cursor/rules/video-sdk-project.mdc` and `video-sdk-typescript.mdc`:

1. **`index.ts`** — wiring only, no business logic
2. **Routes** — thin; call services, return JSON
3. **Auth** — never import signaling or rooms
4. **Signaling** — relay only; don't parse SDP deeply
5. **Adapters** — swap via factory (`createAuthAdapter`), not if/else in routes
6. **ESM imports** — use `.js` extension in TypeScript imports (NodeNext)

File naming:

| Pattern | Meaning |
|---------|---------|
| `*.adapter.ts` | Pluggable implementation |
| `*.plugin.ts` | Fastify plugin |
| `*.types.ts` | Types only |
| `*-service.ts` | Business logic |
| `*-store.ts` | Persistence layer |

---

## What's not in the codebase yet

Knowing gaps helps you avoid searching for things that don't exist:

| Feature | Status | Likely future location |
|---------|--------|------------------------|
| Redis room store | ❌ | `src/rooms/redis-room-store.ts` |
| SFU group meetings (6 peers) | ✅ | `src/sfu/`, `MeetingClient`, `/v1/meetings` |
| Meeting lobby (host admit) | ✅ | `handlers/lobby.ts`, `MeetingLobbyPanel` |
| In-meeting chat | ✅ | `handlers/meeting-chat.ts`, `MeetingChatPanel` |
| Screen share (meetings) | ✅ | `MeetingClient.startScreenShare` |
| Virtual backgrounds | ✅ (client) | Simfree admin `virtual-background.ts` |
| Recording | ❌ | separate service |
| Production auth service | ❌ | external; session adapter calls it |
| Native mobile SDK | ❌ | new package |
| Rate limiting / metrics | ❌ | Fastify plugins |

---

## Related docs

| Document | Use when |
|----------|----------|
| [`PLAN.md`](../PLAN.md) | Learning *why* each phase was built |
| [`docs/frontend-integration.md`](frontend-integration.md) | Integrating any frontend app |
| [`docs/deployment-split-servers.md`](deployment-split-servers.md) | App and video API on separate hosts |
| [`docs/coturn-vps.md`](coturn-vps.md) | TURN server on VPS |
| [`.cursor/rules/video-sdk-project.mdc`](../.cursor/rules/video-sdk-project.mdc) | AI + contributor conventions |

---

## Suggested learning schedule

| Day | Focus | Outcome |
|-----|-------|---------|
| 1 | Steps 0–2 (config + auth) | Can explain JWT flow and env vars |
| 2 | Steps 3–4 (rooms + signaling) | Can trace WS messages through handlers |
| 3 | Steps 5–6 (ICE route + SDK + demo) | Can run a two-tab call and read `VideoClient` |
| 4 | Step 7 + TURN docs | Understand relay when P2P fails |

---

## Maintaining this guide

Update this file when you add modules, rename paths, or introduce new layers.

### Checklist

1. Update [Repository map](#repository-map) if folders change.
2. Add files to [Module reference](#module-reference-every-backend-file).
3. Extend [Trace a 1:1 call](#trace-a-11-call-file-by-file) if the runtime flow changes.
4. Add rows to [What's not in the codebase yet](#whats-not-in-the-codebase-yet) when features ship (move to reading order).
5. Bump **Last updated** at the top.

### When a new phase lands in `PLAN.md`

Add a matching **Step N** section under [Recommended reading order](#recommended-reading-order) with file table + self-check question.
