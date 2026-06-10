# Video SDK Service — Atomic Build Plan

> **Purpose:** Independent microservice for raw WebRTC audio/video calling with pluggable auth.  
> **Learning mode:** One atomic step at a time. Each step explains **Why**, **Tradeoffs**, and **How**.

---

## Project context

| Decision | Choice | Why |
|----------|--------|-----|
| HTTP framework | **Fastify + TypeScript** | Low overhead, plugin model fits modular auth/signaling |
| Media | **Raw WebRTC** (no LiveKit/Twilio SDK) | Full control; we own signaling + session logic |
| Auth | **Pluggable adapter** (JWT first, session later) | Auth service is external; swap without touching video logic |
| STUN | Public (Google/Cloudflare) initially | Free, fine for dev and many P2P cases |
| TURN | **Self-hosted on VPS** (coturn) later | No vendor lock-in; relay when P2P fails |

---

## Modular architecture (target)

Clean separation — each module exposes interfaces, not implementations.

```
src/
├── index.ts                 # Bootstrap only — wire plugins & routes
├── config/                  # Env + ICE server config (no business logic)
├── auth/                    # AuthAdapter interface + JWT/session impls
├── plugins/                 # Fastify plugins (auth, websocket)
├── routes/                  # HTTP handlers (thin — delegate to services)
├── rooms/                   # Room model + store (in-memory → Redis later)
├── signaling/               # WebSocket message handlers (SDP, ICE relay)
├── turn/                    # TURN credential generation (coturn secret)
└── types/                   # Shared domain types
```

**Rules:**
- Routes **do not** contain business logic — call services/handlers.
- Auth **never** imports from signaling or rooms directly — use `AuthContext` type.
- Signaling **relays** messages; it does not parse SDP deeply (peers handle WebRTC).
- Config is **read-only** at startup (except ICE credentials which are generated per request).

---

## How to use this plan

1. Pick the **next unchecked step** only.
2. Implement **only the files listed** for that step.
3. Run the **Verify** command before moving on.
4. Mark step `[x]` in this file when done.
5. When asking the AI for the next step, expect:
   - **Why** — problem this step solves
   - **Tradeoffs** — what we chose vs alternatives
   - **How** — what each file does and how to test

---

## Progress tracker

| Phase | Status |
|-------|--------|
| 0 — Foundation | ✅ Complete |
| 1 — Pluggable auth | ✅ Complete |
| 2 — ICE / STUN | ✅ Complete |
| 3 — Rooms | ✅ Complete |
| 4 — Signaling (WebSocket) | ✅ Complete |
| 5 — TURN (VPS / coturn) | ✅ Complete |
| 6 — Browser SDK | ✅ Complete |
| 7 — SFU meetings | ✅ Complete |

**Frontend docs:** [`docs/frontend-integration.md`](docs/frontend-integration.md) — update when adding user-facing API/SDK features.

**Codebase tour:** [`docs/codebase-exploration.md`](docs/codebase-exploration.md) — file map and reading order for learning the repo.

---

## Phase 0 — Foundation

### Step 0.1 — Project scaffold ✅

**Files:** `package.json`, `tsconfig.json`, `.gitignore`, `.env.example`

**Why:** Establishes TypeScript + ESM + scripts before any feature code.

**Tradeoffs:**
| Choice | Pros | Cons |
|--------|------|------|
| ESM (`"type": "module"`) | Modern Node default, matches Fastify docs | Slightly stricter import paths (`.js` in imports later) |
| `tsx` for dev | No build step while learning | Prod still uses `tsc` → `node dist/` |

**How:** `npm install` → `npm run typecheck`

**Verify:** `npm run typecheck` exits 0

---

### Step 0.2 — Minimal Fastify server ✅

**Files:** `src/index.ts`

**Why:** Proves the server boots and HTTP works before adding modules.

**Tradeoffs:**
| Choice | Pros | Cons |
|--------|------|------|
| Health route in `index.ts` | Simple for step 0.2 | Moved to `routes/` in step 0.4 |

**How:** Fastify instance + `GET /health` returning `{ status, service }`.

**Verify:** `npm run dev` → `curl http://localhost:3000/health`

---

### Step 0.3 — Config module ✅

**Files:** `src/config/env.ts`, update `src/index.ts`, update `.env.example`

**Why:** Centralize env parsing so routes/plugins never read `process.env` directly.

**Tradeoffs:**
| Choice | Pros | Cons |
|--------|------|------|
| Plain object + validation | No extra deps, easy to learn | Manual validation vs `zod`/`envalid` |
| Fail fast at startup | Bad config caught early | Server won't start with missing vars |

**How:** Load `.env` via `dotenv`, export typed `config` object `{ port, host, nodeEnv }`.

**Verify:** Change `PORT` in `.env`, restart, server listens on new port.

---

### Step 0.4 — Route modularization ✅

**Files:** `src/routes/health.ts`, update `src/index.ts`

**Why:** First modular split — routes register via Fastify plugin pattern.

**Tradeoffs:**
| Choice | Pros | Cons |
|--------|------|------|
| One file per route group | Easy to find, scales well | More files for tiny apps |
| `fastify-plugin` wrapper | Encapsulation, correct decorator scope | Extra dependency |

**How:** Export `healthRoutes` as async plugin; `index.ts` only wires plugins.

**Verify:** `/health` still works after refactor.

---

## Phase 1 — Pluggable auth

### Step 1.1 — Auth adapter interface ✅

**Files:** `src/auth/types.ts`, `src/auth/auth-adapter.interface.ts`

**Why:** Decouple "who is this user?" from JWT vs session vs external API.

**Tradeoffs:**
| Choice | Pros | Cons |
|--------|------|------|
| Interface + DI at bootstrap | Swappable, testable with mock | Slightly more wiring in `index.ts` |
| Middleware reads adapter from `app.decorate` | Fastify-native | Must document decorator contract |

**How:** Define `AuthUser`, `AuthResult`, `AuthAdapter.authenticate(token | cookie)`.

**Verify:** Typecheck only; no runtime yet.

---

### Step 1.2 — JWT auth adapter ✅

**Files:** `src/auth/jwt-auth.adapter.ts`, update `.env.example`

**Why:** First concrete adapter — validates Bearer JWT with shared secret or public key.

**Tradeoffs:**
| Choice | Pros | Cons |
|--------|------|------|
| `jsonwebtoken` library | Battle-tested | Sync verify; fine for our scale |
| HS256 (shared secret) first | Simple for monorepo auth | RS256 better for multi-service (add later) |

**How:** Read `JWT_SECRET`, verify `Authorization: Bearer <token>`, map payload → `AuthUser`.

**Verify:** Unit test or manual curl with signed token (document in step).

---

### Step 1.3 — Auth Fastify plugin ✅

**Files:** `src/plugins/auth.plugin.ts`

**Why:** Reusable hook — protected routes call `request.user` without repeating JWT logic.

**Tradeoffs:**
| Choice | Pros | Cons |
|--------|------|------|
| `preHandler` hook per route | Explicit opt-in | Must add to each protected route |
| Global hook + allowlist | Less repetition | Easy to accidentally expose routes |

**How:** Decorate `request` with `user`; export `requireAuth` preHandler.

**Verify:** Protected stub route returns 401 without token, 200 with valid JWT.

---

### Step 1.4 — Session adapter stub ✅

**Files:** `src/auth/session-auth.adapter.ts`

**Why:** Proves plug-in pattern — second adapter without changing routes.

**Tradeoffs:**
| Choice | Pros | Cons |
|--------|------|------|
| Stub that calls external auth HTTP API | Realistic for microservices | Needs auth service URL in env |
| Implement later with real API | Keeps momentum on JWT path | Stub must document expected contract |

**How:** Same `AuthAdapter` interface; `authenticate` reads session cookie → calls auth service.

**Verify:** Swap adapter in `index.ts` config; JWT routes still work with JWT adapter.

---

## Phase 2 — ICE / STUN

### Step 2.1 — ICE config module ✅

**Files:** `src/config/ice.ts`, update `.env.example`

**Why:** Clients need STUN URLs before any call; keep ICE sources env-driven.

**Tradeoffs:**
| Choice | Pros | Cons |
|--------|------|------|
| STUN from env JSON/list | Swap without code change | Misconfig possible |
| Google public STUN default | Works out of the box | Not ideal for high-scale prod |

**How:** Parse `STUN_URLS`, return `{ iceServers: [{ urls }] }`.

**Verify:** Log config at startup in dev.

---

### Step 2.2 — ICE servers endpoint ✅

**Files:** `src/routes/ice-servers.ts`

**Why:** Authenticated clients fetch ICE config from us (later includes TURN creds).

**Tradeoffs:**
| Choice | Pros | Cons |
|--------|------|------|
| Protected endpoint | Prevents abuse of our TURN bandwidth | Client must auth before call setup |
| Public STUN in response | Standard WebRTC pattern | TURN creds must be short-lived |

**How:** `GET /v1/ice-servers` + `requireAuth` → returns `iceServers` array.

**Verify:** curl with JWT returns iceServers JSON.

---

## Phase 3 — Rooms

### Step 3.1 — Room model + store ✅

**Files:** `src/rooms/types.ts`, `src/rooms/room-store.ts`

**Why:** Calls happen in rooms; store tracks participants before WebSocket exists.

**Tradeoffs:**
| Choice | Pros | Cons |
|--------|------|------|
| In-memory Map | Zero deps, fast to learn | Lost on restart; single instance only |
| Redis later | Multi-instance | Adds infra complexity |

**How:** `Room { id, createdAt, participants: Map<userId, ...> }`, CRUD on store interface.

**Verify:** Simple script or route test creating/listing rooms.

---

### Step 3.2 — Room REST API ✅

**Files:** `src/routes/rooms.ts`

**Why:** HTTP creates/joins room before WS signaling connects.

**Tradeoffs:**
| Choice | Pros | Cons |
|--------|------|------|
| POST create, POST join | RESTful, easy to test | Join logic duplicated with WS join (share service) |
| Room ID as UUID | No collisions | Long URLs |

**How:** Thin routes → `RoomService.create()`, `RoomService.join(user)`.

**Verify:** Create room, join with two different JWT users.

---

## Phase 4 — Signaling (WebSocket)

### Step 4.1 — WebSocket plugin ✅

**Files:** `src/plugins/websocket.plugin.ts`, `@fastify/websocket`

**Why:** WebRTC needs persistent channel for SDP and ICE relay.

**Tradeoffs:**
| Choice | Pros | Cons |
|--------|------|------|
| `@fastify/websocket` | Integrates with Fastify lifecycle | WS auth differs from HTTP |
| Raw `ws` library | More control | More boilerplate |

**How:** Register WS at `/v1/signaling`; echo test message first.

**Verify:** Connect with `wscat`, receive echo.

---

### Step 4.2 — Auth on WS connect ✅

**Files:** `src/signaling/auth.ts`

**Why:** Only identified users may signal.

**Tradeoffs:**
| Choice | Pros | Cons |
|--------|------|------|
| JWT in query string | Simple for browsers | Token in URL logs — use short-lived tokens |
| First message auth | Token not in URL | Extra round trip |

**How:** Reuse `AuthAdapter` on connect; close with 4401 if invalid.

**Verify:** WS without token closes; with token stays open.

---

### Step 4.3 — Join room via WS ✅

**Files:** `src/signaling/handlers/join.ts`, `src/signaling/message-types.ts`

**Why:** Tie socket to a room + user for targeted relay.

**Tradeoffs:**
| Choice | Pros | Cons |
|--------|------|------|
| JSON message protocol | Easy to debug | Need version field for evolution |
| Must join HTTP room first | Double validation | Safer — room exists before signal |

**How:** `{ type: 'join', roomId }` → validate user in room → register socket.

**Verify:** Two clients join same room; server acks both.

---

### Step 4.4 — Relay SDP offer/answer ✅

**Files:** `src/signaling/handlers/sdp.ts`

**Why:** Peers cannot connect without exchanging SDP through server.

**Tradeoffs:**
| Choice | Pros | Cons |
|--------|------|------|
| Server blind relay | Simple, no SDP parsing | No recording/transcoding (fine for P2P) |
| Target by peer userId | 1:1 calls clear | Mesh group calls need fan-out (later) |

**How:** `{ type: 'offer'|'answer', to, sdp }` → forward to peer socket in room.

**Verify:** Two browser tabs exchange offer/answer through server logs.

---

### Step 4.5 — Relay ICE candidates ✅

**Files:** `src/signaling/handlers/ice-candidate.ts`

**Why:** NAT traversal requires candidate exchange after SDP.

**Tradeoffs:**
| Choice | Pros | Cons |
|--------|------|------|
| Trickle ICE (one candidate per msg) | Faster connect | More messages |
| Same relay pattern as SDP | Consistent | Must not drop candidates under load |

**How:** `{ type: 'ice-candidate', to, candidate }` → forward to peer.

**Verify:** Browser `RTCPeerConnection` completes ICE; media flows P2P.

---

## Phase 5 — TURN (VPS / coturn)

### Step 5.1 — TURN credential generation ✅

**Files:** `src/turn/credentials.ts`, update `src/routes/ice-servers.ts`, `.env.example`

**Why:** TURN on VPS needs time-limited username/credential (coturn `use-auth-secret`).

**Tradeoffs:**
| Choice | Pros | Cons |
|--------|------|------|
| HMAC-based temp creds | Standard coturn pattern | Requires shared secret with VPS |
| 24h credential TTL | Less churn | Long window if leaked |
| 1h TTL | Safer | More refreshes |

**How:** Generate username/expiry + credential; append to `iceServers` when `TURN_URL` set.

**Verify:** `/v1/ice-servers` includes turn entry when env configured.

---

### Step 5.2 — coturn VPS setup ✅

**Files:** `docs/coturn-vps.md` (ops doc, not runtime code)

**Why:** Document how to run coturn on VPS — ports, firewall, shared secret.

**Tradeoffs:**
| Choice | Pros | Cons |
|--------|------|------|
| Same VPS as API | Cheap | Bandwidth contention |
| Dedicated TURN VPS | Better isolation | Extra cost |

**How:** Install coturn, open UDP 3478 + relay range, match secret with service env.

**Verify:** WebRTC ICE candidate includes `relay` type in browser devtools.

---

## Phase 6 — Browser SDK (later)

### Step 6.1 — Minimal client wrapper ✅

**Files:** `packages/client-sdk/` (separate package)

**Why:** Apps should not hand-roll WS protocol + RTCPeerConnection every time.

**Tradeoffs:**
| Choice | Pros | Cons |
|--------|------|------|
| Thin wrapper over raw WebRTC | Learning-friendly, no magic | Apps still handle UI |
| Monorepo package | Version lock with server | More tooling |

**How:** `VideoClient.connect({ token, roomId })` → handles WS + peer connection.

**Verify:** Two-browser demo page in `examples/`.

---

## Phase 7 — SFU group meetings

### Step 7.1 — mediasoup SFU core ✅

**Files:** `src/sfu/*`, `src/plugins/sfu.plugin.ts`, `src/signaling/handlers/sfu.ts`, `src/signaling/message-types.ts`

**Why:** P2P mesh does not scale beyond 1:1; SFU forwards RTP server-side.

**Verify:** `npm run typecheck` · two clients join same meeting code and exchange audio/video.

---

### Step 7.2 — Meeting links + guest tokens ✅

**Files:** `src/routes/meetings.ts`, `src/rooms/*`, `src/config/env.ts`

**Why:** Shareable short codes; guests join without staff accounts.

**Verify:** `POST /v1/meetings` → `POST /v1/meetings/:code/guest-token` → guest WS join.

---

### Step 7.3 — MeetingClient SDK ✅

**Files:** `packages/client-sdk/src/meeting-client.ts`, sync to `@simfree/video-client`

**Why:** Apps should not hand-roll mediasoup signaling.

**Verify:** `npm run typecheck:all` · Simfree admin `/meet/[code]`.

---

### Step 7.4 — Screen share + virtual backgrounds ✅

**Files:** `MeetingClient.startScreenShare`, `apps/admin` meeting UI + `virtual-background.ts`

**Verify:** Share screen in meeting; toggle blur/image background.

---

### Step 7.5 — VPS deploy ✅

**Files:** `deploy/setup-server.sh`, `.env.example` (`MEDIASOUP_*`, `MEETING_BASE_URL`)

**Why:** SFU media requires UDP/TCP on `MEDIASOUP_PORT` with public `MEDIASOUP_ANNOUNCED_IP`.

**Verify:** Open firewall port · `curl /health` · join meeting on production admin URL.

---

## Environment variables (living list)

| Variable | Phase | Description |
|----------|-------|-------------|
| `PORT` | 0 | HTTP port (default 3000) |
| `HOST` | 0 | Bind address (default 0.0.0.0) |
| `NODE_ENV` | 0 | development / production |
| `JWT_SECRET` | 1 | HS256 secret for JWT adapter |
| `STUN_URLS` | 2 | Comma-separated STUN URLs |
| `TURN_URL` | 5 | turn:your-vps:3478 |
| `TURN_SECRET` | 5 | Shared secret with coturn |
| `MEDIASOUP_ANNOUNCED_IP` | 7 | Public IP for SFU WebRTC |
| `MEDIASOUP_PORT` | 7 | SFU listen port (default 40000) |
| `SFU_MAX_PEERS` | 7 | Max meeting participants |
| `MEETING_BASE_URL` | 7 | Frontend base for join links |
| `GUEST_JWT_TTL_SECONDS` | 7 | Guest token TTL |

---

## Commands

```bash
npm run dev        # Development with hot reload
npm run build      # Compile to dist/
npm run start      # Run compiled output
npm run typecheck  # TypeScript without emit
```

---

## Next step

Phases 0–7 complete. For production: deploy API + coturn + mediasoup SFU on VPS, set `MEDIASOUP_ANNOUNCED_IP`, and rebuild Simfree admin with `@simfree/video-client`.

See `docs/coturn-vps.md` to finish TURN on your VPS.
