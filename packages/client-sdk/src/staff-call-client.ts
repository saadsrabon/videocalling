import type {
  CallInvitePayload,
  IceServersResponse,
  RoomCreateResponse,
  StaffCallClientOptions,
  StaffCallEvent,
  StaffCallEventHandler,
  StaffCallState,
} from "./types.js";
import { authHeaders, jsonPostInit, normalizeServerUrl, normalizeToken } from "./http.js";

type ServerMessage =
  | { type: "connected"; userId: string }
  | { type: "joined"; roomId: string; participants: string[] }
  | { type: "peer-joined"; userId: string }
  | { type: "offer"; from: string; sdp: string }
  | { type: "answer"; from: string; sdp: string }
  | { type: "ice-candidate"; from: string; candidate: RTCIceCandidateInit }
  | CallInvitePayload
  | {
      type: "call.accept" | "call.reject" | "call.end" | "call.cancel";
      from: string;
      to: string;
      callId: string;
      roomId: string;
    }
  | { type: "error"; code: string; message: string };

export class StaffCallClient {
  private readonly serverUrl: string;
  private readonly getToken: StaffCallClientOptions["getToken"];
  private localVideo?: HTMLVideoElement;
  private remoteVideo?: HTMLVideoElement;
  private readonly handlers = new Set<StaffCallEventHandler>();

  private token = "";
  private _userId = "";
  private ws: WebSocket | null = null;
  private localStream: MediaStream | null = null;
  private readonly peers = new Map<string, RTCPeerConnection>();
  private iceServers: RTCIceServer[] = [];
  private presenceReady = false;
  private presencePromise: Promise<void> | null = null;

  private state: StaffCallState = "idle";
  private activeCallId: string | null = null;
  private activeRoomId: string | null = null;
  private peerUserId: string | null = null;
  private isCallInitiator = false;
  private incomingInvite: CallInvitePayload | null = null;
  private signalingJoined = false;
  private remoteStream: MediaStream | null = null;
  private readonly pendingIceCandidates = new Map<string, RTCIceCandidateInit[]>();
  private readonly deferredOfferPeerIds = new Set<string>();
  private signalingJoinWaiter: ((roomId: string) => void) | null = null;
  private signalingJoinRoomId: string | null = null;

  private constructor(options: StaffCallClientOptions) {
    this.serverUrl = normalizeServerUrl(options.serverUrl);
    this.getToken = options.getToken;
    this.localVideo = options.localVideo;
    this.remoteVideo = options.remoteVideo;
  }

  get userId(): string {
    return this._userId;
  }

  get callState(): StaffCallState {
    return this.state;
  }

  get currentInvite(): CallInvitePayload | null {
    return this.incomingInvite;
  }

  static async create(options: StaffCallClientOptions): Promise<StaffCallClient> {
    const client = new StaffCallClient(options);
    await client.ensurePresence();
    return client;
  }

  on(handler: StaffCallEventHandler): void {
    this.handlers.add(handler);
  }

  off(handler: StaffCallEventHandler): void {
    this.handlers.delete(handler);
  }

  setVideoElements(local?: HTMLVideoElement, remote?: HTMLVideoElement): void {
    if (local) {
      this.localVideo = local;
      this.attachLocalVideo();
    }

    if (remote) {
      this.remoteVideo = remote;
      this.attachRemoteVideo();
    }
  }

  private attachLocalVideo(): void {
    if (this.localVideo && this.localStream) {
      this.localVideo.srcObject = this.localStream;
    }
  }

  private attachRemoteVideo(): void {
    if (this.remoteVideo && this.remoteStream) {
      this.remoteVideo.srcObject = this.remoteStream;
      void this.remoteVideo.play().catch(() => {
        /* autoplay policy — user already in call */
      });
    }
  }

  private queueIceCandidate(peerId: string, candidate: RTCIceCandidateInit): void {
    const queue = this.pendingIceCandidates.get(peerId) ?? [];
    queue.push(candidate);
    this.pendingIceCandidates.set(peerId, queue);
  }

  private async flushIceCandidates(peerId: string, pc: RTCPeerConnection): Promise<void> {
    const queued = this.pendingIceCandidates.get(peerId) ?? [];
    this.pendingIceCandidates.delete(peerId);

    for (const candidate of queued) {
      try {
        await pc.addIceCandidate(candidate);
      } catch {
        /* ignore stale candidates */
      }
    }
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
    await this.refreshToken();
    await this.loadIceServers();

    const createResponse = await fetch(`${this.serverUrl}/v1/rooms`, {
      method: "POST",
      ...jsonPostInit(this.token),
    });

    if (!createResponse.ok) {
      throw new Error(`Failed to create room (${createResponse.status})`);
    }

    const created = (await createResponse.json()) as RoomCreateResponse;
    const roomId = created.roomId;
    const callId = crypto.randomUUID();

    const joinResponse = await fetch(`${this.serverUrl}/v1/rooms/${roomId}/join`, {
      method: "POST",
      ...jsonPostInit(this.token),
    });

    if (!joinResponse.ok) {
      throw new Error(`Failed to join room (${joinResponse.status})`);
    }

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
    if (!this.incomingInvite || this.state !== "incoming") {
      throw new Error("No incoming call");
    }

    const invite = this.incomingInvite;
    await this.refreshToken();
    await this.loadIceServers();

    const joinResponse = await fetch(
      `${this.serverUrl}/v1/rooms/${invite.roomId}/join`,
      {
        method: "POST",
        ...jsonPostInit(this.token),
      },
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

    await this.beginMediaSession(invite.roomId);
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

  setMicMuted(muted: boolean): void {
    for (const track of this.localStream?.getAudioTracks() ?? []) {
      track.enabled = !muted;
    }
  }

  isMicMuted(): boolean {
    const tracks = this.localStream?.getAudioTracks() ?? [];
    return tracks.length > 0 && tracks.every((track) => !track.enabled);
  }

  setCameraOff(off: boolean): void {
    for (const track of this.localStream?.getVideoTracks() ?? []) {
      track.enabled = !off;
    }
  }

  isCameraOff(): boolean {
    const tracks = this.localStream?.getVideoTracks() ?? [];
    return tracks.length > 0 && tracks.every((track) => !track.enabled);
  }

  setRemoteAudioMuted(muted: boolean): void {
    if (this.remoteVideo) {
      this.remoteVideo.muted = muted;
    }
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
    if (this.state === "outgoing" && this.activeCallId && this.activeRoomId && this.peerUserId) {
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

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
    }

    this.ws = null;
    this.presenceReady = false;
    this.presencePromise = null;
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

      const onConnected = (event: StaffCallEvent) => {
        if (event.type !== "connected") {
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

  private async beginMediaSession(roomId: string): Promise<void> {
    this.setState("connecting");
    this.signalingJoined = false;
    this.deferredOfferPeerIds.clear();
    this.signalingJoinRoomId = roomId;

    this.send({ type: "join", roomId });
    await this.waitForSignalingJoined(roomId);
    await this.startLocalMedia();
    await this.flushDeferredOffers();
  }

  private waitForSignalingJoined(roomId: string): Promise<void> {
    if (this.signalingJoined && this.signalingJoinRoomId === roomId) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.signalingJoinWaiter = null;
        reject(new Error("Signaling join timed out"));
      }, 15_000);

      this.signalingJoinWaiter = (joinedRoomId) => {
        window.clearTimeout(timeout);
        this.signalingJoinWaiter = null;

        if (joinedRoomId === roomId) {
          resolve();
        }
      };
    });
  }

  private queueOfferPeer(peerId: string): void {
    if (peerId === this._userId) {
      return;
    }

    this.deferredOfferPeerIds.add(peerId);
  }

  private async flushDeferredOffers(): Promise<void> {
    if (!this.isCallInitiator || !this.signalingJoined || !this.localStream) {
      return;
    }

    for (const peerId of [...this.deferredOfferPeerIds]) {
      this.deferredOfferPeerIds.delete(peerId);
      await this.createOfferTo(peerId);
    }
  }

  private async loadIceServers(): Promise<void> {
    const iceResponse = await fetch(`${this.serverUrl}/v1/ice-servers`, {
      headers: authHeaders(this.token),
    });

    if (!iceResponse.ok) {
      throw new Error(`Failed to fetch ICE servers (${iceResponse.status})`);
    }

    const icePayload = (await iceResponse.json()) as IceServersResponse;
    this.iceServers = icePayload.iceServers;
  }

  private async refreshToken(): Promise<void> {
    this.token = normalizeToken(await this.getToken());
  }

  private wsUrl(): string {
    const wsBase = this.serverUrl.replace(/^http/, "ws");
    return `${wsBase}/v1/signaling?token=${encodeURIComponent(this.token)}`;
  }

  private send(message: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Signaling socket is not open");
    }

    this.ws.send(JSON.stringify(message));
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

  private resetCallState(): void {
    this.activeCallId = null;
    this.activeRoomId = null;
    this.peerUserId = null;
    this.isCallInitiator = false;
    this.incomingInvite = null;
    this.setState("idle");
  }

  private cleanupCall(): void {
    for (const pc of this.peers.values()) {
      pc.close();
    }

    this.peers.clear();
    this.pendingIceCandidates.clear();
    this.deferredOfferPeerIds.clear();
    this.signalingJoined = false;
    this.signalingJoinWaiter = null;
    this.signalingJoinRoomId = null;
    this.remoteStream = null;

    if (this.localStream) {
      for (const track of this.localStream.getTracks()) {
        track.stop();
      }

      this.localStream = null;
    }

    if (this.localVideo) {
      this.localVideo.srcObject = null;
    }

    if (this.remoteVideo) {
      this.remoteVideo.srcObject = null;
    }
  }

  private async startLocalMedia(): Promise<void> {
    if (this.localStream) {
      this.attachLocalVideo();
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("This browser does not support camera/microphone access");
    }

    const isLocalhost =
      window.location.hostname === "localhost" ||
      window.location.hostname === "127.0.0.1";

    if (window.location.protocol !== "https:" && !isLocalhost) {
      throw new Error(
        "Camera/mic requires HTTPS on LAN. Open admin via https://YOUR_LAN_IP:3002",
      );
    }

    this.localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: true,
    });

    this.attachLocalVideo();
  }

  private getOrCreatePeer(peerId: string): RTCPeerConnection {
    const existing = this.peers.get(peerId);

    if (existing) {
      return existing;
    }

    const pc = new RTCPeerConnection({ iceServers: this.iceServers });

    if (this.localStream) {
      for (const track of this.localStream.getTracks()) {
        pc.addTrack(track, this.localStream);
      }
    }

    pc.ontrack = (event) => {
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      this.remoteStream = stream;
      this.attachRemoteVideo();
      this.emit({ type: "remote-stream", userId: peerId, stream });
      this.setState("active");
    };

    pc.onicecandidate = (event) => {
      if (!this.signalingJoined || !event.candidate) {
        return;
      }

      this.send({
        type: "ice-candidate",
        to: peerId,
        candidate: event.candidate.toJSON(),
      });
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        this.peers.delete(peerId);
      }
    };

    this.peers.set(peerId, pc);
    return pc;
  }

  private async createOfferTo(peerId: string): Promise<void> {
    if (!this.signalingJoined || !this.localStream) {
      this.queueOfferPeer(peerId);
      return;
    }

    const pc = this.getOrCreatePeer(peerId);
    const offer = await pc.createOffer();

    if (!offer.sdp) {
      throw new Error("Failed to create SDP offer");
    }

    await pc.setLocalDescription(offer);

    this.send({
      type: "offer",
      to: peerId,
      sdp: offer.sdp,
    });
  }

  private async handleServerMessage(raw: string): Promise<void> {
    let message: ServerMessage;

    try {
      message = JSON.parse(raw) as ServerMessage;
    } catch {
      this.emit({ type: "error", message: "Invalid signaling message" });
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
          this.state === "outgoing" &&
          message.callId === this.activeCallId &&
          message.roomId === this.activeRoomId
        ) {
          await this.beginMediaSession(message.roomId);
        }

        break;

      case "call.reject":
      case "call.cancel":
        if (message.callId === this.activeCallId) {
          this.cleanupCall();
          this.resetCallState();
          this.emit({
            type: "call-ended",
            reason: message.type === "call.reject" ? "rejected" : "cancelled",
          });
        }

        break;

      case "call.end":
        if (message.callId === this.activeCallId) {
          this.cleanupCall();
          this.resetCallState();
          this.emit({ type: "call-ended", reason: "ended" });
        }

        break;

      case "joined":
        this.signalingJoined = true;
        this.signalingJoinWaiter?.(message.roomId);
        this.emit({
          type: "room-ready",
          roomId: message.roomId,
          participants: message.participants,
        });

        if (this.isCallInitiator) {
          for (const participantId of message.participants) {
            this.queueOfferPeer(participantId);
          }

          await this.flushDeferredOffers();
        }

        break;

      case "peer-joined":
        if (this.isCallInitiator && this.signalingJoined) {
          this.queueOfferPeer(message.userId);
          await this.flushDeferredOffers();
        }

        break;

      case "offer":
        await this.handleOffer(message.from, message.sdp);
        break;

      case "answer":
        await this.handleAnswer(message.from, message.sdp);
        break;

      case "ice-candidate":
        await this.handleIceCandidate(message.from, message.candidate);
        break;

      case "error":
        this.emit({ type: "error", message: message.message });

        if (
          message.code === "not_signaled" &&
          this.activeRoomId &&
          (this.state === "connecting" || this.state === "active")
        ) {
          this.signalingJoined = false;
          this.send({ type: "join", roomId: this.activeRoomId });
        }

        if (this.state === "outgoing" && message.code === "peer_unavailable") {
          this.cleanupCall();
          this.resetCallState();
          this.emit({ type: "call-ended", reason: "unavailable" });
        }

        break;
    }
  }

  private async handleOffer(from: string, sdp: string): Promise<void> {
    if (!this.signalingJoined && this.activeRoomId) {
      this.send({ type: "join", roomId: this.activeRoomId });
      await this.waitForSignalingJoined(this.activeRoomId);
    }

    if (!this.localStream) {
      await this.startLocalMedia();
    }

    const pc = this.getOrCreatePeer(from);
    await pc.setRemoteDescription({ type: "offer", sdp });
    await this.flushIceCandidates(from, pc);
    const answer = await pc.createAnswer();

    if (!answer.sdp) {
      throw new Error("Failed to create SDP answer");
    }

    await pc.setLocalDescription(answer);

    this.send({
      type: "answer",
      to: from,
      sdp: answer.sdp,
    });

    this.setState("active");
  }

  private async handleAnswer(from: string, sdp: string): Promise<void> {
    const pc = this.peers.get(from);

    if (!pc) {
      return;
    }

    await pc.setRemoteDescription({ type: "answer", sdp });
    await this.flushIceCandidates(from, pc);
    this.setState("active");
  }

  private async handleIceCandidate(
    from: string,
    candidate: RTCIceCandidateInit,
  ): Promise<void> {
    const pc = this.peers.get(from);

    if (!pc || !pc.remoteDescription) {
      this.queueIceCandidate(from, candidate);
      return;
    }

    try {
      await pc.addIceCandidate(candidate);
    } catch {
      this.queueIceCandidate(from, candidate);
    }
  }
}
