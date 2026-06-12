import { Device } from "mediasoup-client";
import type {
  Consumer,
  DtlsParameters,
  Producer,
  Transport,
} from "mediasoup-client/types";
import type {
  GuestTokenResponse,
  IceServersResponse,
  MediaSource,
  MeetingClientEvent,
  MeetingClientEventHandler,
  MeetingClientJoinOptions,
  MeetingCreateResponse,
  MeetingJoinResponse,
  MeetingJoinStatus,
  ParticipantInfo,
} from "./types.js";
import { authHeaders, jsonPostInit, normalizeServerUrl, normalizeToken } from "./http.js";

type ServerMessage =
  | { type: "connected"; userId: string }
  | {
      type: "joined";
      roomId: string;
      participants: string[];
      roster?: ParticipantInfo[];
      hostUserId?: string | null;
      mode?: "p2p" | "sfu";
    }
  | { type: "peer-joined"; userId: string; displayName?: string }
  | {
      type: "lobby.waiting";
      roomId: string;
      hostUserId: string | null;
    }
  | {
      type: "lobby.admitted";
      roomId: string;
      roster: ParticipantInfo[];
      hostUserId?: string | null;
      userId?: string;
      participant?: ParticipantInfo;
    }
  | {
      type: "lobby.denied";
      roomId: string;
      userId?: string;
      message?: string;
    }
  | {
      type: "lobby.request";
      roomId: string;
      userId: string;
      displayName: string;
    }
  | {
      type: "lobby.list";
      roomId: string;
      waiting: ParticipantInfo[];
    }
  | {
      type: "meeting.chat";
      roomId: string;
      id: string;
      from: string;
      displayName: string;
      text: string;
      sentAt: string;
    }
  | { type: "sfu.peerLeft"; roomId: string; peerId: string }
  | {
      type: "sfu.rtpCapabilities";
      requestId: string;
      rtpCapabilities: unknown;
    }
  | {
      type: "sfu.transportCreated";
      requestId: string;
      transportId: string;
      iceParameters: unknown;
      iceCandidates: unknown[];
      dtlsParameters: unknown;
    }
  | { type: "sfu.transportConnected"; requestId: string }
  | { type: "sfu.produced"; requestId: string; producerId: string }
  | {
      type: "sfu.consumed";
      requestId: string;
      consumerId: string;
      producerId: string;
      kind: "audio" | "video";
      rtpParameters: unknown;
      appData?: { source?: string };
    }
  | { type: "sfu.consumerResumed"; requestId: string }
  | {
      type: "sfu.producerList";
      requestId: string;
      producers: Array<{
        peerId: string;
        producerId: string;
        kind: "audio" | "video";
        source?: string;
      }>;
    }
  | {
      type: "sfu.newProducer";
      roomId: string;
      peerId: string;
      producerId: string;
      kind: "audio" | "video";
      appData?: { source?: string };
    }
  | {
      type: "sfu.producerClosed";
      roomId: string;
      peerId: string;
      producerId: string;
    }
  | { type: "error"; code: string; message: string };

interface RemoteTrackMeta {
  consumerId: string;
  producerId: string;
  peerId: string;
  kind: "audio" | "video";
  source: MediaSource;
  consumer: Consumer;
  stream: MediaStream;
}

interface PendingConsume {
  peerId: string;
  producerId: string;
  kind: "audio" | "video";
  source: MediaSource;
}

function describeTrack(track: MediaStreamTrack): Record<string, unknown> {
  return {
    id: track.id,
    kind: track.kind,
    readyState: track.readyState,
    muted: track.muted,
    enabled: track.enabled,
    label: track.label,
  };
}

const MEDIA_PORT_HINT =
  "Open UDP/TCP ports 40000–40100 on the video server (AWS security group) for SFU media.";

async function getUserMediaWithRetry(
  log: (message: string, data?: Record<string, unknown>) => void,
): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Camera/mic API not available — use HTTPS and a supported browser");
  }

  const attempts: MediaStreamConstraints[] = [
    { audio: true, video: true },
    {
      audio: true,
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24 } },
    },
    {
      audio: true,
      video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24 } },
    },
  ];

  let lastError: unknown;

  for (let attempt = 0; attempt < attempts.length; attempt += 1) {
    const constraints = attempts[attempt]!;

    try {
      log("requesting getUserMedia", { attempt: attempt + 1, constraints });
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      log("getUserMedia succeeded", {
        attempt: attempt + 1,
        video: stream.getVideoTracks().map((track) => describeTrack(track)),
        audio: stream.getAudioTracks().map((track) => describeTrack(track)),
      });
      return stream;
    } catch (error) {
      lastError = error;
      const name = error instanceof DOMException ? error.name : "Error";
      const message = error instanceof Error ? error.message : String(error);
      log("getUserMedia failed", { attempt: attempt + 1, name, message });

      if (name === "NotAllowedError" || name === "SecurityError") {
        throw error;
      }

      if (attempt < attempts.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    }
  }

  if (lastError instanceof DOMException && lastError.name === "AbortError") {
    throw new Error(
      `Camera timed out (${lastError.message}). Close other apps using the camera and try again.`,
    );
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Could not start camera or microphone");
}

export class MeetingClient {
  private readonly serverUrl: string;
  private readonly token: string;
  private readonly code: string;
  private readonly displayName?: string;
  private readonly ghostMode: boolean;
  private recvTransportConnected: Promise<void> | null = null;
  private readonly handlers = new Set<MeetingClientEventHandler>();

  private ws: WebSocket | null = null;
  private device: Device | null = null;
  private sendTransport: Transport | null = null;
  private recvTransport: Transport | null = null;
  private localStream: MediaStream | null = null;
  private screenStream: MediaStream | null = null;
  private micProducer: Producer | null = null;
  private cameraProducer: Producer | null = null;
  private screenProducer: Producer | null = null;
  private customVideoTrack: MediaStreamTrack | null = null;

  private _userId = "";
  private roomId = "";
  private hostUserId: string | null = null;
  private joinStatus: MeetingJoinStatus = "admitted";
  private readonly roster = new Map<string, ParticipantInfo>();
  private micMuted = false;
  private cameraOff = false;
  private closed = false;
  private lobbyAdmittedResolve: (() => void) | null = null;
  private lobbyAdmittedReject: ((error: Error) => void) | null = null;

  private readonly pendingRequests = new Map<
    string,
    { resolve: (value: ServerMessage) => void; reject: (error: Error) => void }
  >();
  private requestCounter = 0;

  private readonly remoteTracks = new Map<string, RemoteTrackMeta>();
  private readonly producerIndex = new Map<string, string>();
  private readonly pendingConsumes: PendingConsume[] = [];
  private joinOptions: MeetingClientJoinOptions | null = null;
  private intentionalLeave = false;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 5;
  private resyncInProgress = false;
  private mediaSessionReady = false;

  private constructor(options: MeetingClientJoinOptions) {
    this.serverUrl = normalizeServerUrl(options.serverUrl);
    this.token = normalizeToken(options.token);
    this.code = options.code.trim().toUpperCase();
    this.displayName = options.displayName?.trim() || undefined;
    this.ghostMode = options.ghostMode === true;
  }

  get isGhostMode(): boolean {
    return this.ghostMode;
  }

  get userId(): string {
    return this._userId;
  }

  get currentRoomId(): string {
    return this.roomId;
  }

  get isHost(): boolean {
    return Boolean(this.hostUserId && this._userId === this.hostUserId);
  }

  get currentJoinStatus(): MeetingJoinStatus {
    return this.joinStatus;
  }

  getParticipantRoster(): ParticipantInfo[] {
    return [...this.roster.values()];
  }

  getDisplayName(userId: string): string {
    return this.roster.get(userId)?.displayName ?? userId;
  }

  get localMediaStream(): MediaStream | null {
    return this.localStream;
  }

  static async createMeeting(
    serverUrl: string,
    token: string,
    title?: string,
  ): Promise<MeetingCreateResponse> {
    const baseUrl = normalizeServerUrl(serverUrl);
    const response = await fetch(`${baseUrl}/v1/meetings`, {
      method: "POST",
      headers: {
        ...authHeaders(token),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(title ? { title } : {}),
    });

    if (!response.ok) {
      throw new Error(`Failed to create meeting (${response.status})`);
    }

    return (await response.json()) as MeetingCreateResponse;
  }

  static async fetchGuestToken(
    serverUrl: string,
    code: string,
    name: string,
  ): Promise<GuestTokenResponse> {
    const baseUrl = normalizeServerUrl(serverUrl);
    const response = await fetch(
      `${baseUrl}/v1/meetings/${encodeURIComponent(code)}/guest-token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      },
    );

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as
        | { message?: string }
        | null;
      throw new Error(body?.message ?? `Guest token failed (${response.status})`);
    }

    return (await response.json()) as GuestTokenResponse;
  }

  static async join(options: MeetingClientJoinOptions): Promise<MeetingClient> {
    const client = new MeetingClient(options);
    await client.connectAndJoin(options);
    return client;
  }

  on(handler: MeetingClientEventHandler): void {
    this.handlers.add(handler);
  }

  off(handler: MeetingClientEventHandler): void {
    this.handlers.delete(handler);
  }

  setMicMuted(muted: boolean): void {
    this.micMuted = muted;
    const track = this.localStream?.getAudioTracks()[0];
    if (track) {
      track.enabled = !muted;
    }
  }

  isMicMuted(): boolean {
    return this.micMuted;
  }

  setCameraOff(off: boolean): void {
    this.cameraOff = off;
    const track = this.localStream?.getVideoTracks()[0];
    if (track) {
      track.enabled = !off;
    }
  }

  isCameraOff(): boolean {
    return this.cameraOff;
  }

  async setVideoSource(track: MediaStreamTrack): Promise<void> {
    this.customVideoTrack = track;

    if (this.cameraProducer && !this.cameraProducer.closed) {
      await this.cameraProducer.replaceTrack({ track });
      return;
    }

    if (this.sendTransport && this.device?.canProduce("video")) {
      this.cameraProducer = await this.sendTransport.produce({
        track,
        appData: { source: "camera" },
      });
    }
  }

  async startScreenShare(): Promise<void> {
    if (this.screenProducer && !this.screenProducer.closed) {
      return;
    }

    this.screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: false,
    });

    const track = this.screenStream.getVideoTracks()[0];
    if (!track || !this.sendTransport) {
      throw new Error("Screen share transport not ready");
    }

    track.onended = () => {
      void this.stopScreenShare();
    };

    this.screenProducer = await this.sendTransport.produce({
      track,
      appData: { source: "screen" },
    });

    this.emit({ type: "screen-share-started" });
  }

  async stopScreenShare(): Promise<void> {
    if (this.screenProducer && !this.screenProducer.closed) {
      const producerId = this.screenProducer.id;
      await this.request("sfu.closeProducer", {
        roomId: this.roomId,
        producerId,
      });
      this.screenProducer.close();
      this.screenProducer = null;
    }

    this.screenStream?.getTracks().forEach((track) => track.stop());
    this.screenStream = null;
    this.emit({ type: "screen-share-stopped" });
  }

  isScreenSharing(): boolean {
    return Boolean(this.screenProducer && !this.screenProducer.closed);
  }

  admitParticipant(userId: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Signaling socket is not open");
    }

    this.ws.send(
      JSON.stringify({
        type: "lobby.admit",
        roomId: this.roomId,
        userId,
      }),
    );
  }

  denyParticipant(userId: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Signaling socket is not open");
    }

    this.ws.send(
      JSON.stringify({
        type: "lobby.deny",
        roomId: this.roomId,
        userId,
      }),
    );
  }

  listWaitingParticipants(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Signaling socket is not open");
    }

    this.ws.send(
      JSON.stringify({
        type: "lobby.list",
        roomId: this.roomId,
      }),
    );
  }

  sendChat(text: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Signaling socket is not open");
    }

    this.ws.send(
      JSON.stringify({
        type: "meeting.chat.send",
        roomId: this.roomId,
        text,
      }),
    );
  }

  /** Re-fetch and consume missing remote producers (after reconnect or missed tracks). */
  async resyncRemoteMedia(): Promise<void> {
    if (!this.mediaSessionReady || this.closed) {
      return;
    }

    if (this.resyncInProgress) {
      return;
    }

    this.resyncInProgress = true;
    this.emit({ type: "media-syncing" });

    try {
      await this.waitForRecvTransportConnected();

      const existingProducers = await this.listExistingProducers();
      const missing = existingProducers.filter(
        (producer) => !this.remoteTracks.has(producer.producerId),
      );

      this.log("resync remote media", {
        total: existingProducers.length,
        missing: missing.length,
      });

      if (missing.length === 0) {
        return;
      }

      for (const producer of missing) {
        await this.consumeRemoteProducerWithRetry(
          producer.peerId,
          producer.producerId,
          producer.kind,
          producer.source,
        );
      }

      await this.flushPendingConsumes();
      this.emit({ type: "media-ready" });
    } finally {
      this.resyncInProgress = false;
    }
  }

  async leave(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.intentionalLeave = true;
    this.closed = true;

    for (const meta of this.remoteTracks.values()) {
      meta.consumer.close();
    }
    this.remoteTracks.clear();
    this.producerIndex.clear();

    this.micProducer?.close();
    this.cameraProducer?.close();
    this.screenProducer?.close();
    this.sendTransport?.close();
    this.recvTransport?.close();

    this.localStream?.getTracks().forEach((track) => track.stop());
    this.screenStream?.getTracks().forEach((track) => track.stop());
    this.customVideoTrack?.stop();

    this.ws?.close();
    this.ws = null;
  }

  private emit(event: MeetingClientEvent): void {
    for (const handler of this.handlers) {
      handler(event);
    }
  }

  private log(message: string, data?: Record<string, unknown>): void {
    if (data) {
      console.log(`[Meeting][${this.code}] ${message}`, data);
      return;
    }

    console.log(`[Meeting][${this.code}] ${message}`);
  }

  private watchTrack(track: MediaStreamTrack, label: string): void {
    this.log(`track snapshot (${label})`, describeTrack(track));
    track.addEventListener("mute", () =>
      this.log(`track muted (${label})`, describeTrack(track)),
    );
    track.addEventListener("unmute", () =>
      this.log(`track unmuted (${label})`, describeTrack(track)),
    );
    track.addEventListener("ended", () =>
      this.log(`track ended (${label})`, describeTrack(track)),
    );
  }

  private nextRequestId(): string {
    this.requestCounter += 1;
    return `req-${this.requestCounter}`;
  }

  private request(
    type: string,
    payload: Record<string, unknown>,
  ): Promise<ServerMessage> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Signaling socket is not open"));
    }

    const requestId = this.nextRequestId();

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(requestId, { resolve, reject });
      this.ws!.send(JSON.stringify({ type, requestId, ...payload }));
    });
  }

  private updateRoster(entries: ParticipantInfo[]): void {
    for (const entry of entries) {
      this.roster.set(entry.userId, entry);
    }

    this.emit({ type: "participant-roster", roster: this.getParticipantRoster() });
  }

  private emitJoined(roomId: string, participants: string[], roster: ParticipantInfo[]): void {
    this.emit({
      type: "joined",
      roomId,
      participants,
      roster,
      hostUserId: this.hostUserId,
    });
  }

  private handleServerMessage(message: ServerMessage): void {
    if ("requestId" in message && message.requestId) {
      const pending = this.pendingRequests.get(message.requestId);
      if (pending) {
        this.pendingRequests.delete(message.requestId);
        pending.resolve(message);
        return;
      }
    }

    switch (message.type) {
      case "connected":
        this._userId = message.userId;
        this.emit({ type: "connected", userId: message.userId });
        break;
      case "joined":
        this.roomId = message.roomId;
        if (message.hostUserId !== undefined) {
          this.hostUserId = message.hostUserId;
        }
        if (message.roster) {
          this.updateRoster(message.roster);
        }
        this.joinStatus = "admitted";
        this.emitJoined(
          message.roomId,
          message.participants,
          message.roster ?? this.getParticipantRoster(),
        );
        break;
      case "lobby.waiting":
        this.joinStatus = "waiting";
        if (message.hostUserId !== undefined) {
          this.hostUserId = message.hostUserId;
        }
        this.emit({
          type: "lobby-waiting",
          roomId: message.roomId,
          hostUserId: message.hostUserId,
        });
        break;
      case "lobby.admitted":
        this.joinStatus = "admitted";
        if (message.hostUserId !== undefined) {
          this.hostUserId = message.hostUserId;
        }
        this.updateRoster(message.roster);
        this.emit({
          type: "lobby-admitted",
          roomId: message.roomId,
          roster: message.roster,
          hostUserId: this.hostUserId,
        });
        this.emitJoined(
          message.roomId,
          message.roster.map((entry) => entry.userId).filter((id) => id !== this._userId),
          message.roster,
        );
        this.lobbyAdmittedResolve?.();
        this.lobbyAdmittedResolve = null;
        this.lobbyAdmittedReject = null;
        break;
      case "lobby.denied":
        this.emit({
          type: "lobby-denied",
          roomId: message.roomId,
          message: message.message,
        });
        this.lobbyAdmittedReject?.(
          new Error(message.message ?? "The host declined your request to join"),
        );
        this.lobbyAdmittedResolve = null;
        this.lobbyAdmittedReject = null;
        break;
      case "lobby.request":
        this.emit({
          type: "lobby-request",
          roomId: message.roomId,
          userId: message.userId,
          displayName: message.displayName,
        });
        break;
      case "lobby.list":
        this.emit({
          type: "lobby-waiting-list",
          waiting: message.waiting,
        });
        break;
      case "meeting.chat":
        this.emit({
          type: "chat-message",
          id: message.id,
          from: message.from,
          displayName: message.displayName,
          text: message.text,
          sentAt: message.sentAt,
        });
        break;
      case "peer-joined":
        if (message.displayName) {
          this.roster.set(message.userId, {
            userId: message.userId,
            displayName: message.displayName,
          });
        }
        this.emit({
          type: "peer-joined",
          userId: message.userId,
          displayName: message.displayName,
        });
        this.schedulePeerMediaSync(message.userId);
        break;
      case "sfu.peerLeft":
        this.removePeerTracks(message.peerId);
        this.emit({ type: "peer-left", userId: message.peerId });
        break;
      case "sfu.newProducer":
        if (message.peerId === this._userId) {
          return;
        }
        this.log("sfu.newProducer", {
          peerId: message.peerId,
          producerId: message.producerId,
          kind: message.kind,
          source: message.appData?.source ?? "camera",
        });
        void this.consumeRemoteProducerWithRetry(
          message.peerId,
          message.producerId,
          message.kind,
          message.appData?.source === "screen" ? "screen" : "camera",
        ).catch((error) => {
          const errMsg =
            error instanceof Error ? error.message : "Consume failed";
          this.log("consume failed (newProducer)", {
            producerId: message.producerId,
            error: errMsg,
          });
        });
        break;
      case "sfu.producerClosed":
        this.removeProducerTrack(message.producerId);
        break;
      case "error":
        this.emit({ type: "error", message: message.message });
        break;
      default:
        break;
    }
  }

  private removePeerTracks(peerId: string): void {
    for (const [producerId, metaPeerId] of this.producerIndex) {
      if (metaPeerId === peerId) {
        this.removeProducerTrack(producerId);
      }
    }
  }

  private removeProducerTrack(producerId: string): void {
    const meta = this.remoteTracks.get(producerId);
    if (!meta) {
      return;
    }

    meta.consumer.close();
    meta.stream.getTracks().forEach((track) => track.stop());
    this.remoteTracks.delete(producerId);
    this.producerIndex.delete(producerId);

    this.emit({
      type: "track-removed",
      peerId: meta.peerId,
      producerId,
      source: meta.source,
    });
  }

  private waitForRecvTransportConnected(timeoutMs = 15000): Promise<void> {
    if (!this.recvTransport) {
      return Promise.resolve();
    }

    if (this.recvTransport.connectionState === "connected") {
      return Promise.resolve();
    }

    if (!this.recvTransportConnected) {
      this.recvTransportConnected = new Promise((resolve, reject) => {
        const transport = this.recvTransport!;

        const timeout = window.setTimeout(() => {
          cleanup();
          reject(new Error("Receive transport connection timed out"));
        }, timeoutMs);

        const onStateChange = (state: string) => {
          if (state === "connected") {
            cleanup();
            resolve();
          } else if (state === "failed" || state === "closed") {
            cleanup();
            reject(new Error(`Receive transport ${state}`));
          }
        };

        const cleanup = () => {
          window.clearTimeout(timeout);
          transport.off("connectionstatechange", onStateChange);
          this.recvTransportConnected = null;
        };

        transport.on("connectionstatechange", onStateChange);

        if (transport.connectionState === "connected") {
          cleanup();
          resolve();
        }
      });
    }

    return this.recvTransportConnected;
  }

  private watchTransportState(direction: "send" | "recv", transport: Transport): void {
    transport.on("connectionstatechange", (state) => {
      this.log(`${direction} transport connection state`, { state });

      if (state === "connected") {
        return;
      }

      if (state === "failed" || state === "disconnected") {
        const message =
          state === "failed"
            ? `Media connection failed (${direction}). ${MEDIA_PORT_HINT}`
            : `${direction} transport ${state}`;

        this.emit({
          type: "transport-state",
          direction,
          state,
          message,
        });

        if (state === "failed" && this.mediaSessionReady) {
          void this.resyncRemoteMedia();
        }
      }
    });
  }

  private emitConnectionState(
    state: "connecting" | "connected" | "reconnecting" | "disconnected",
    message?: string,
  ): void {
    this.emit({ type: "connection-state", state, message });
  }

  private async connectAndJoin(options: MeetingClientJoinOptions): Promise<void> {
    this.joinOptions = options;
    this.emitConnectionState("connecting", "Joining meeting…");
    const baseUrl = this.serverUrl;
    const headers = authHeaders(this.token);

    const joinResult = await this.httpJoin(baseUrl, headers);
    this.roomId = joinResult.roomId;
    this.hostUserId = joinResult.hostUserId;
    this.joinStatus = joinResult.status;
    this.updateRoster(joinResult.participants);

    await this.openSignaling();

    if (joinResult.status === "waiting") {
      await this.waitForLobbyAdmitted();
    } else {
      await this.waitForJoined();
    }

    this.log(this.ghostMode ? "ghost observer joining (no publish)" : "acquiring camera/mic after admission");

    if (!this.ghostMode) {
      this.localStream = await getUserMediaWithRetry((message, data) =>
        this.log(message, data),
      );
    }

    const iceResponse = await fetch(`${baseUrl}/v1/ice-servers`, { headers });
    if (!iceResponse.ok) {
      throw new Error(`Failed to fetch ICE servers (${iceResponse.status})`);
    }

    void ((await iceResponse.json()) as IceServersResponse);

    await this.startMediasoupSession();
    this.emitConnectionState("connected");
  }

  private async httpJoin(
    baseUrl: string,
    headers: HeadersInit,
  ): Promise<MeetingJoinResponse> {
    const joinResponse = await fetch(
      `${baseUrl}/v1/meetings/${encodeURIComponent(this.code)}/join`,
      {
        method: "POST",
        ...jsonPostInit(this.token),
        body: JSON.stringify({
          ...(this.displayName ? { displayName: this.displayName } : {}),
          ...(this.ghostMode ? { ghost: true } : {}),
        }),
      },
    );

    if (!joinResponse.ok) {
      const guestJoin = await fetch(
        `${baseUrl}/v1/meetings/${encodeURIComponent(this.code)}/guest-join`,
        {
          method: "POST",
          headers: {
            ...headers,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            token: this.token,
            ...(this.displayName ? { displayName: this.displayName } : {}),
          }),
        },
      );

      if (!guestJoin.ok) {
        throw new Error(`Failed to join meeting (${joinResponse.status})`);
      }

      return (await guestJoin.json()) as MeetingJoinResponse;
    }

    return (await joinResponse.json()) as MeetingJoinResponse;
  }

  private openSignaling(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wsUrl = new URL(`${this.serverUrl}/v1/signaling`);
      wsUrl.searchParams.set("token", this.token);
      this.ws = new WebSocket(wsUrl.toString());

      this.ws.onopen = () => {
        this.reconnectAttempts = 0;
        resolve();
      };
      this.ws.onerror = () => reject(new Error("WebSocket connection failed"));
      this.ws.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as ServerMessage;
        this.handleServerMessage(message);
      };
      this.ws.onclose = () => {
        if (this.intentionalLeave || this.closed) {
          return;
        }

        void this.handleSignalingDisconnect();
      };
    });
  }

  private async handleSignalingDisconnect(): Promise<void> {
    if (this.intentionalLeave || this.closed || !this.joinOptions) {
      return;
    }

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.closed = true;
      this.emitConnectionState("disconnected", "Connection lost");
      this.emit({ type: "error", message: "Connection lost — please reload the page" });
      return;
    }

    this.reconnectAttempts += 1;
    const delayMs = Math.min(1000 * 2 ** (this.reconnectAttempts - 1), 8000);
    this.emitConnectionState(
      "reconnecting",
      `Reconnecting (${this.reconnectAttempts}/${this.maxReconnectAttempts})…`,
    );

    await new Promise((resolve) => setTimeout(resolve, delayMs));

    if (this.intentionalLeave || this.closed) {
      return;
    }

    try {
      await this.reconnectSignaling();
    } catch (error) {
      this.log("reconnect failed", {
        attempt: this.reconnectAttempts,
        error: error instanceof Error ? error.message : String(error),
      });
      void this.handleSignalingDisconnect();
    }
  }

  private async reconnectSignaling(): Promise<void> {
    if (!this.joinOptions) {
      throw new Error("Missing join options");
    }

    this.teardownMediaSession();

    const headers = authHeaders(this.token);
    const joinResult = await this.httpJoin(this.serverUrl, headers);
    this.roomId = joinResult.roomId;
    this.hostUserId = joinResult.hostUserId;
    this.joinStatus = joinResult.status;
    this.updateRoster(joinResult.participants);

    await this.openSignaling();

    if (this.joinStatus === "waiting") {
      await this.waitForLobbyAdmitted();
    } else {
      await this.waitForJoined();
    }

    if (!this.ghostMode && !this.localStream) {
      this.localStream = await getUserMediaWithRetry((message, data) =>
        this.log(message, data),
      );
    }

    await this.startMediasoupSession();
    this.emitConnectionState("connected");
  }

  private teardownMediaSession(): void {
    this.mediaSessionReady = false;

    for (const meta of this.remoteTracks.values()) {
      meta.consumer.close();
    }
    this.remoteTracks.clear();
    this.producerIndex.clear();
    this.pendingConsumes.length = 0;

    this.micProducer?.close();
    this.cameraProducer?.close();
    this.screenProducer?.close();
    this.micProducer = null;
    this.cameraProducer = null;
    this.screenProducer = null;

    this.sendTransport?.close();
    this.recvTransport?.close();
    this.sendTransport = null;
    this.recvTransport = null;
    this.device = null;
  }

  private waitForJoined(): Promise<void> {
    return new Promise((resolve, reject) => {
      const handler: MeetingClientEventHandler = (event) => {
        if (event.type === "joined") {
          this.off(handler);
          resolve();
        } else if (event.type === "error") {
          this.off(handler);
          reject(new Error(event.message));
        }
      };

      this.on(handler);
      this.ws?.send(JSON.stringify({ type: "join", roomId: this.roomId }));
    });
  }

  private waitForLobbyAdmitted(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.lobbyAdmittedResolve = resolve;
      this.lobbyAdmittedReject = reject;

      const handler: MeetingClientEventHandler = (event) => {
        if (event.type === "lobby-admitted" || event.type === "joined") {
          this.off(handler);
        } else if (event.type === "lobby-denied") {
          this.off(handler);
          reject(new Error(event.message ?? "The host declined your request to join"));
        } else if (event.type === "error") {
          this.off(handler);
          reject(new Error(event.message));
        }
      };

      this.on(handler);
      this.ws?.send(JSON.stringify({ type: "join", roomId: this.roomId }));
    });
  }

  private async startMediasoupSession(): Promise<void> {
    const capsMessage = (await this.request("sfu.getRtpCapabilities", {
      roomId: this.roomId,
    })) as Extract<ServerMessage, { type: "sfu.rtpCapabilities" }>;

    this.device = new Device();
    await this.device.load({
      routerRtpCapabilities: capsMessage.rtpCapabilities as never,
    });

    if (this.ghostMode) {
      await this.createRecvTransport();
      await this.waitForRecvTransportConnected();
    } else {
      await this.createSendTransport();
      await this.createRecvTransport();
      await this.waitForRecvTransportConnected();
      await this.startLocalMedia();
    }

    const existingProducers = await this.listExistingProducers();
    this.log("existing producers in room", {
      count: existingProducers.length,
      producers: existingProducers,
    });

    for (const producer of existingProducers) {
      await this.consumeRemoteProducerWithRetry(
        producer.peerId,
        producer.producerId,
        producer.kind,
        producer.source,
      );
    }

    await this.flushPendingConsumes();
    this.mediaSessionReady = true;
    this.log("mediasoup session ready", { userId: this._userId, roomId: this.roomId });
    this.emit({ type: "media-ready" });
    this.scheduleDelayedResync();
  }

  private scheduleDelayedResync(): void {
    for (const delayMs of [1500, 4000]) {
      window.setTimeout(() => {
        if (!this.closed && this.mediaSessionReady) {
          void this.resyncRemoteMedia();
        }
      }, delayMs);
    }
  }

  private schedulePeerMediaSync(peerId: string): void {
    for (const delayMs of [0, 800, 2000, 4500]) {
      window.setTimeout(() => {
        if (this.closed || !this.mediaSessionReady) {
          return;
        }

        void this.syncPeerMedia(peerId).catch((error) => {
          this.log("sync peer media failed", {
            peerId,
            delayMs,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }, delayMs);
    }
  }

  private async flushPendingConsumes(): Promise<void> {
    if (this.pendingConsumes.length === 0) {
      return;
    }

    const queue = [...this.pendingConsumes];
    this.pendingConsumes.length = 0;
    this.log("flushing queued consumes", { count: queue.length });

    for (const item of queue) {
      try {
        await this.consumeRemoteProducerWithRetry(
          item.peerId,
          item.producerId,
          item.kind,
          item.source,
        );
      } catch (error) {
        const errMsg =
          error instanceof Error ? error.message : "Queued consume failed";
        this.log("queued consume failed", {
          producerId: item.producerId,
          error: errMsg,
        });
        this.emit({ type: "error", message: errMsg });
      }
    }
  }

  private async listExistingProducers(): Promise<
    Array<{
      peerId: string;
      producerId: string;
      kind: "audio" | "video";
      source: MediaSource;
    }>
  > {
    const response = (await this.request("sfu.listProducers", {
      roomId: this.roomId,
    })) as Extract<ServerMessage, { type: "sfu.producerList" }>;

    return response.producers.map((producer) => ({
      peerId: producer.peerId,
      producerId: producer.producerId,
      kind: producer.kind,
      source: producer.source === "screen" ? "screen" : "camera",
    }));
  }

  private async syncPeerMedia(peerId: string): Promise<void> {
    if (!this.mediaSessionReady) {
      return;
    }

    const producers = (await this.listExistingProducers()).filter(
      (producer) => producer.peerId === peerId,
    );

    for (const producer of producers) {
      await this.consumeRemoteProducerWithRetry(
        producer.peerId,
        producer.producerId,
        producer.kind,
        producer.source,
      );
    }
  }

  private async consumeRemoteProducerWithRetry(
    peerId: string,
    producerId: string,
    kind: "audio" | "video",
    source: MediaSource,
    maxAttempts = 3,
  ): Promise<void> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await this.consumeRemoteProducer(peerId, producerId, kind, source);
        return;
      } catch (error) {
        lastError = error;
        this.log("consume retry", {
          producerId,
          attempt,
          error: error instanceof Error ? error.message : String(error),
        });

        if (attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
        }
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error("Consume failed after retries");
  }

  private async createSendTransport(): Promise<void> {
    const created = (await this.request("sfu.createTransport", {
      roomId: this.roomId,
      direction: "send",
    })) as Extract<ServerMessage, { type: "sfu.transportCreated" }>;

    if (!this.device) {
      throw new Error("Device not loaded");
    }

    this.sendTransport = this.device.createSendTransport({
      id: created.transportId,
      iceParameters: created.iceParameters as never,
      iceCandidates: created.iceCandidates as never,
      dtlsParameters: created.dtlsParameters as never,
    });

    this.watchTransportState("send", this.sendTransport);

    this.sendTransport.on(
      "connect",
      (
        { dtlsParameters }: { dtlsParameters: DtlsParameters },
        callback: () => void,
        errback: (error: Error) => void,
      ) => {
      void this.request("sfu.connectTransport", {
        roomId: this.roomId,
        transportId: this.sendTransport!.id,
        dtlsParameters,
      })
        .then(() => callback())
        .catch((error) =>
          errback(error instanceof Error ? error : new Error(String(error))),
        );
    });

    this.sendTransport.on(
      "produce",
      (
        {
          kind,
          rtpParameters,
          appData,
        }: {
          kind: "audio" | "video";
          rtpParameters: Record<string, unknown>;
          appData?: Record<string, unknown>;
        },
        callback: (params: { id: string }) => void,
        errback: (error: Error) => void,
      ) => {
      void this.request("sfu.produce", {
        roomId: this.roomId,
        transportId: this.sendTransport!.id,
        kind,
        rtpParameters,
        appData,
      })
        .then((response) => {
          const produced = response as Extract<ServerMessage, { type: "sfu.produced" }>;
          callback({ id: produced.producerId });
        })
        .catch((error) =>
          errback(error instanceof Error ? error : new Error(String(error))),
        );
    });
  }

  private async createRecvTransport(): Promise<void> {
    const created = (await this.request("sfu.createTransport", {
      roomId: this.roomId,
      direction: "recv",
    })) as Extract<ServerMessage, { type: "sfu.transportCreated" }>;

    if (!this.device) {
      throw new Error("Device not loaded");
    }

    this.recvTransport = this.device.createRecvTransport({
      id: created.transportId,
      iceParameters: created.iceParameters as never,
      iceCandidates: created.iceCandidates as never,
      dtlsParameters: created.dtlsParameters as never,
    });

    this.watchTransportState("recv", this.recvTransport);

    this.recvTransport.on(
      "connect",
      (
        { dtlsParameters }: { dtlsParameters: DtlsParameters },
        callback: () => void,
        errback: (error: Error) => void,
      ) => {
      void this.request("sfu.connectTransport", {
        roomId: this.roomId,
        transportId: this.recvTransport!.id,
        dtlsParameters,
      })
        .then(() => callback())
        .catch((error) =>
          errback(error instanceof Error ? error : new Error(String(error))),
        );
    });
  }

  private async startLocalMedia(): Promise<void> {
    if (!this.localStream) {
      this.localStream = await getUserMediaWithRetry((message, data) =>
        this.log(message, data),
      );
    }

    const audioTrack = this.localStream.getAudioTracks()[0];
    const videoTrack = this.customVideoTrack ?? this.localStream.getVideoTracks()[0];

    if (audioTrack && this.sendTransport) {
      this.micProducer = await this.sendTransport.produce({
        track: audioTrack,
        appData: { source: "mic" },
      });
      this.log("local mic produced", {
        producerId: this.micProducer.id,
        track: describeTrack(audioTrack),
      });
    } else {
      this.log("local mic missing — no audio producer", {
        hasAudioTrack: Boolean(audioTrack),
        hasSendTransport: Boolean(this.sendTransport),
      });
    }

    if (videoTrack && this.sendTransport) {
      this.cameraProducer = await this.sendTransport.produce({
        track: videoTrack,
        appData: { source: "camera" },
      });
      this.log("local camera produced", {
        producerId: this.cameraProducer.id,
        track: describeTrack(videoTrack),
      });
    } else {
      this.log("local camera missing — no video producer", {
        hasVideoTrack: Boolean(videoTrack),
        hasSendTransport: Boolean(this.sendTransport),
      });
    }
  }

  private async consumeRemoteProducer(
    peerId: string,
    producerId: string,
    kind: "audio" | "video",
    source: MediaSource,
  ): Promise<void> {
    if (!this.device || !this.recvTransport) {
      if (!this.pendingConsumes.some((item) => item.producerId === producerId)) {
        this.pendingConsumes.push({ peerId, producerId, kind, source });
        this.log("queued consume (recv transport not ready)", {
          peerId,
          producerId,
          kind,
          source,
        });
      }
      return;
    }

    if (this.remoteTracks.has(producerId)) {
      this.log("skip duplicate consume", { producerId, peerId, kind });
      return;
    }

    const consumed = (await this.request("sfu.consume", {
      roomId: this.roomId,
      producerId,
      rtpCapabilities: this.device.rtpCapabilities,
    })) as Extract<ServerMessage, { type: "sfu.consumed" }>;

    const consumer = await this.recvTransport.consume({
      id: consumed.consumerId,
      producerId: consumed.producerId,
      kind: consumed.kind,
      rtpParameters: consumed.rtpParameters as never,
    });

    await this.request("sfu.resumeConsumer", {
      roomId: this.roomId,
      consumerId: consumer.id,
    });

    if (!consumer.track) {
      throw new Error(`Consumer ${consumer.id} has no track (${kind})`);
    }

    const stream = new MediaStream([consumer.track]);
    const resolvedSource =
      consumed.appData?.source === "screen" ? "screen" : source;

    this.log("remote track ready", {
      peerId,
      producerId,
      consumerId: consumer.id,
      kind,
      source: resolvedSource,
      track: describeTrack(consumer.track),
      paused: consumer.paused,
    });
    this.watchTrack(consumer.track, `${peerId}/${kind}`);

    consumer.on("transportclose", () => {
      this.log("consumer transport closed", { producerId, peerId, kind });
    });
    consumer.on("trackended", () => {
      this.log("consumer track ended", { producerId, peerId, kind });
    });

    this.remoteTracks.set(producerId, {
      consumerId: consumer.id,
      producerId,
      peerId,
      kind,
      source: resolvedSource,
      consumer,
      stream,
    });
    this.producerIndex.set(producerId, peerId);

    this.emit({
      type: "track-added",
      peerId,
      kind,
      source: resolvedSource,
      track: consumer.track,
      stream,
    });
  }
}
