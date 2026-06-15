import { Room, RoomEvent, Track, createLocalTracks } from "livekit-client";
import type {
  CallInvitePayload,
  StaffCallClientOptions,
  StaffCallEvent,
  StaffCallEventHandler,
  StaffCallState,
} from "./types.js";
import { jsonPostInit, normalizeServerUrl, normalizeToken } from "./http.js";

type ServerMessage =
  | { type: "connected"; userId: string }
  | { type: "joined"; roomId: string; participants: string[] }
  | { type: "peer-joined"; userId: string }
  | CallInvitePayload
  | {
      type: "call.accept" | "call.reject" | "call.end" | "call.cancel";
      from: string;
      to: string;
      callId: string;
      roomId: string;
    }
  | { type: "error"; code: string; message: string };

interface LiveKitTokenPayload {
  server_url: string;
  participant_token: string;
}

/** Staff 1:1 calls over LiveKit SFU; signaling WS unchanged for ring/accept UX. */
export class LiveKitStaffCallClient {
  private readonly serverUrl: string;
  private readonly getToken: StaffCallClientOptions["getToken"];
  private localVideo?: HTMLVideoElement;
  private remoteVideo?: HTMLVideoElement;
  private readonly handlers = new Set<StaffCallEventHandler>();

  private token = "";
  private _userId = "";
  private ws: WebSocket | null = null;
  private lkRoom: Room | null = null;
  private localStream: MediaStream | null = null;
  private presenceReady = false;
  private presencePromise: Promise<void> | null = null;

  private state: StaffCallState = "idle";
  private activeCallId: string | null = null;
  private activeRoomId: string | null = null;
  private peerUserId: string | null = null;
  private isCallInitiator = false;
  private incomingInvite: CallInvitePayload | null = null;

  private constructor(options: StaffCallClientOptions) {
    this.serverUrl = normalizeServerUrl(options.serverUrl);
    this.getToken = options.getToken;
    this.localVideo = options.localVideo;
    this.remoteVideo = options.remoteVideo;
  }

  static async create(
    options: StaffCallClientOptions,
  ): Promise<LiveKitStaffCallClient> {
    const client = new LiveKitStaffCallClient(options);
    await client.ensurePresence();
    return client;
  }

  get userId(): string {
    return this._userId;
  }

  getState(): StaffCallState {
    return this.state;
  }

  getIncomingInvite(): CallInvitePayload | null {
    return this.incomingInvite;
  }

  on(handler: StaffCallEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  off(handler: StaffCallEventHandler): void {
    this.handlers.delete(handler);
  }

  private emit(event: StaffCallEvent): void {
    for (const handler of this.handlers) {
      handler(event);
    }
  }

  private setState(state: StaffCallState): void {
    this.state = state;
    this.emit({ type: "state-changed", state });
  }

  async startCall(params: {
    targetUserId: string;
    callerName?: string | null;
    callerEmail?: string;
  }): Promise<void> {
    if (this.state !== "idle") {
      throw new Error("Already in a call");
    }

    if (params.targetUserId === this._userId) {
      throw new Error("Cannot call yourself");
    }

    await this.ensurePresence();

    const createResponse = await fetch(`${this.serverUrl}/v1/rooms`, {
      method: "POST",
      ...jsonPostInit(this.token),
    });

    if (!createResponse.ok) {
      throw new Error(`Failed to create call room (${createResponse.status})`);
    }

    const { roomId } = (await createResponse.json()) as { roomId: string };
    const callId = crypto.randomUUID();

    await fetch(`${this.serverUrl}/v1/rooms/${roomId}/join`, {
      method: "POST",
      ...jsonPostInit(this.token),
    });

    this.activeCallId = callId;
    this.activeRoomId = roomId;
    this.peerUserId = params.targetUserId;
    this.isCallInitiator = true;
    this.setState("outgoing");

    this.send({
      type: "call.invite",
      to: params.targetUserId,
      callId,
      roomId,
      fromName: params.callerName ?? undefined,
      fromEmail: params.callerEmail,
    });
  }

  async acceptIncoming(): Promise<void> {
    if (!this.incomingInvite) {
      return;
    }

    const invite = this.incomingInvite;

    const joinResponse = await fetch(
      `${this.serverUrl}/v1/rooms/${invite.roomId}/join`,
      { method: "POST", ...jsonPostInit(this.token) },
    );

    if (!joinResponse.ok) {
      throw new Error(`Failed to join room (${joinResponse.status})`);
    }

    this.activeCallId = invite.callId;
    this.activeRoomId = invite.roomId;
    this.peerUserId = invite.from;
    this.isCallInitiator = false;
    this.incomingInvite = null;

    this.send({
      type: "call.accept",
      to: invite.from,
      callId: invite.callId,
      roomId: invite.roomId,
    });

    await this.connectLiveKit(invite.roomId);
  }

  rejectIncoming(): void {
    if (!this.incomingInvite) {
      return;
    }

    const invite = this.incomingInvite;
    this.send({
      type: "call.reject",
      to: invite.from,
      callId: invite.callId,
      roomId: invite.roomId,
    });

    this.incomingInvite = null;
    this.resetCallState();
  }

  hangup(): void {
    if (
      this.activeCallId &&
      this.activeRoomId &&
      this.peerUserId &&
      this.state !== "idle"
    ) {
      this.send({
        type: "call.end",
        to: this.peerUserId,
        callId: this.activeCallId,
        roomId: this.activeRoomId,
      });
    }

    this.cleanupCall();
    this.resetCallState();
  }

  cancelOutgoing(): void {
    if (
      this.state === "outgoing" &&
      this.activeCallId &&
      this.activeRoomId &&
      this.peerUserId
    ) {
      this.send({
        type: "call.cancel",
        to: this.peerUserId,
        callId: this.activeCallId,
        roomId: this.activeRoomId,
      });
    }

    this.cleanupCall();
    this.resetCallState();
  }

  disconnect(): void {
    this.cleanupCall();
    this.resetCallState();

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.close();
    }

    this.ws = null;
    this.presenceReady = false;
    this.presencePromise = null;
  }

  setMicMuted(muted: boolean): void {
    void this.lkRoom?.localParticipant.setMicrophoneEnabled(!muted);
  }

  isMicMuted(): boolean {
    const pub = this.lkRoom?.localParticipant.getTrackPublication(
      Track.Source.Microphone,
    );
    return pub ? pub.isMuted : false;
  }

  setCameraOff(off: boolean): void {
    void this.lkRoom?.localParticipant.setCameraEnabled(!off);
  }

  isCameraOff(): boolean {
    const pub = this.lkRoom?.localParticipant.getTrackPublication(
      Track.Source.Camera,
    );
    return pub ? !pub.track : true;
  }

  setRemoteAudioMuted(muted: boolean): void {
    if (this.remoteVideo) {
      this.remoteVideo.muted = muted;
    }
  }

  setVideoElements(local?: HTMLVideoElement, remote?: HTMLVideoElement): void {
    this.localVideo = local;
    this.remoteVideo = remote;
  }

  private async ensurePresence(): Promise<void> {
    if (this.presenceReady) {
      return;
    }

    if (this.presencePromise) {
      await this.presencePromise;
      return;
    }

    this.presencePromise = this.connectPresence();
    await this.presencePromise;
  }

  private async connectPresence(): Promise<void> {
    await this.refreshToken();

    await new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl());

      const timeout = window.setTimeout(() => {
        reject(new Error("Signaling connection timed out"));
      }, 15_000);

      this.ws.onmessage = (event) => {
        void this.handleServerMessage(String(event.data));
      };

      this.ws.onerror = () => {
        window.clearTimeout(timeout);
        reject(new Error("WebSocket error"));
      };

      const onConnected = (ev: StaffCallEvent) => {
        if (ev.type !== "connected") {
          return;
        }

        window.clearTimeout(timeout);
        this.off(onConnected);
        this.presenceReady = true;
        resolve();
      };

      this.on(onConnected);
    });
  }

  private async connectLiveKit(roomId: string): Promise<void> {
    this.setState("connecting");

    const tokenResponse = await fetch(
      `${this.serverUrl}/v1/rooms/${roomId}/livekit-token`,
      { method: "POST", ...jsonPostInit(this.token) },
    );

    if (!tokenResponse.ok) {
      throw new Error(`LiveKit token failed (${tokenResponse.status})`);
    }

    const payload = (await tokenResponse.json()) as LiveKitTokenPayload;
    const room = new Room();

    room.on(RoomEvent.TrackSubscribed, (track) => {
      if (track.kind === Track.Kind.Video && this.remoteVideo) {
        track.attach(this.remoteVideo);
      }
      if (track.kind === Track.Kind.Audio && this.remoteVideo) {
        track.attach(this.remoteVideo);
      }
      this.setState("active");
      if (this.remoteVideo && track.mediaStream) {
        this.emit({
          type: "remote-stream",
          userId: this.peerUserId ?? "",
          stream: track.mediaStream,
        });
      }
    });

    room.on(RoomEvent.Disconnected, () => {
      this.emit({ type: "call-ended", reason: "ended" });
      this.cleanupCall();
      this.resetCallState();
    });

    await room.connect(payload.server_url, payload.participant_token);
    this.lkRoom = room;

    const tracks = await createLocalTracks({ audio: true, video: true });
    this.localStream = new MediaStream();
    for (const track of tracks) {
      this.localStream.addTrack(track.mediaStreamTrack);
      await room.localParticipant.publishTrack(track);
      if (track.kind === Track.Kind.Video && this.localVideo) {
        track.attach(this.localVideo);
      }
    }

    this.emit({ type: "room-ready", roomId, participants: [] });
    this.setState("active");
  }

  private async handleServerMessage(raw: string): Promise<void> {
    let message: ServerMessage;
    try {
      message = JSON.parse(raw) as ServerMessage;
    } catch {
      return;
    }

    switch (message.type) {
      case "connected":
        this._userId = message.userId;
        this.emit({ type: "connected", userId: message.userId });
        break;
      case "call.invite":
        if (this.state !== "idle") {
          this.send({
            type: "call.reject",
            to: message.from,
            callId: message.callId,
            roomId: message.roomId,
          });
          break;
        }
        this.incomingInvite = message;
        this.setState("incoming");
        this.emit({ type: "incoming-call", invite: message });
        break;
      case "call.accept":
        if (
          this.isCallInitiator &&
          this.activeRoomId === message.roomId &&
          this.state === "outgoing"
        ) {
          await this.connectLiveKit(message.roomId);
        }
        break;
      case "call.reject":
      case "call.cancel":
        this.emit({ type: "call-ended", reason: "rejected" });
        this.cleanupCall();
        this.resetCallState();
        break;
      case "call.end":
        this.emit({ type: "call-ended", reason: "ended" });
        this.cleanupCall();
        this.resetCallState();
        break;
      default:
        break;
    }
  }

  private async refreshToken(): Promise<void> {
    this.token = normalizeToken(await this.getToken());
  }

  private wsUrl(): string {
    return `${this.serverUrl.replace(/^http/, "ws")}/v1/signaling?token=${encodeURIComponent(this.token)}`;
  }

  private send(payload: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  private cleanupCall(): void {
    void this.lkRoom?.disconnect();
    this.lkRoom = null;

    for (const track of this.localStream?.getTracks() ?? []) {
      track.stop();
    }
    this.localStream = null;
  }

  private resetCallState(): void {
    this.activeCallId = null;
    this.activeRoomId = null;
    this.peerUserId = null;
    this.isCallInitiator = false;
    this.incomingInvite = null;
    this.setState("idle");
  }
}
