import type {
  IceServersResponse,
  RoomCreateResponse,
  VideoClientConnectOptions,
  VideoClientEvent,
  VideoClientEventHandler,
} from "./types.js";
import { authHeaders, jsonPostInit, normalizeServerUrl, normalizeToken } from "./http.js";

type ServerMessage =
  | { type: "connected"; userId: string }
  | { type: "joined"; roomId: string; participants: string[] }
  | { type: "peer-joined"; userId: string }
  | { type: "offer"; from: string; sdp: string }
  | { type: "answer"; from: string; sdp: string }
  | {
      type: "ice-candidate";
      from: string;
      candidate: RTCIceCandidateInit;
    }
  | { type: "error"; code: string; message: string };

export class VideoClient {
  private _userId = "";
  readonly roomId: string;
  private readonly serverUrl: string;
  private readonly token: string;
  private readonly localVideo?: HTMLVideoElement;
  private readonly remoteVideo?: HTMLVideoElement;
  private readonly handlers = new Set<VideoClientEventHandler>();

  private ws: WebSocket | null = null;
  private localStream: MediaStream | null = null;
  private readonly peers = new Map<string, RTCPeerConnection>();
  private iceServers: RTCIceServer[] = [];
  private closed = false;

  private constructor(
    options: VideoClientConnectOptions,
    roomId: string,
  ) {
    this.serverUrl = normalizeServerUrl(options.serverUrl);
    this.token = normalizeToken(options.token);
    this.localVideo = options.localVideo;
    this.remoteVideo = options.remoteVideo;
    this.roomId = roomId;
  }

  get userId(): string {
    return this._userId;
  }

  /** Connect, join room (HTTP + WS), and prepare local media. */
  static async connect(
    options: VideoClientConnectOptions,
  ): Promise<VideoClient> {
    const baseUrl = normalizeServerUrl(options.serverUrl);
    const headers = authHeaders(options.token);

    const iceResponse = await fetch(`${baseUrl}/v1/ice-servers`, { headers });

    if (!iceResponse.ok) {
      const errorBody = (await iceResponse.json().catch(() => null)) as
        | { message?: string; error?: string }
        | null;

      const detail = errorBody?.message ?? errorBody?.error ?? "Unauthorized";

      throw new Error(
        `Failed to fetch ICE servers (${iceResponse.status}): ${detail}. Generate a token with: pnpm token user-a`,
      );
    }

    const icePayload = (await iceResponse.json()) as IceServersResponse;

    let roomId = options.roomId;

    if (!roomId) {
      const createResponse = await fetch(`${baseUrl}/v1/rooms`, {
        method: "POST",
        ...jsonPostInit(options.token),
      });

      if (!createResponse.ok) {
        throw new Error(`Failed to create room (${createResponse.status})`);
      }

      const created = (await createResponse.json()) as RoomCreateResponse;
      roomId = created.roomId;
    }

    const joinResponse = await fetch(`${baseUrl}/v1/rooms/${roomId}/join`, {
      method: "POST",
      ...jsonPostInit(options.token),
    });

    if (!joinResponse.ok) {
      const errorBody = (await joinResponse.json().catch(() => null)) as
        | { message?: string; error?: string }
        | null;

      const detail = errorBody?.message ?? errorBody?.error ?? "Join failed";

      throw new Error(`Failed to join room (${joinResponse.status}): ${detail}`);
    }

    const client = new VideoClient(options, roomId);
    client.iceServers = icePayload.iceServers;

    await client.startLocalMedia();
    await client.connectSignaling();

    return client;
  }

  on(handler: VideoClientEventHandler): void {
    this.handlers.add(handler);
  }

  off(handler: VideoClientEventHandler): void {
    this.handlers.delete(handler);
  }

  getLocalStream(): MediaStream | null {
    return this.localStream;
  }

  /** Mute/unmute your microphone (local audio track). */
  setMicMuted(muted: boolean): void {
    for (const track of this.localStream?.getAudioTracks() ?? []) {
      track.enabled = !muted;
    }
  }

  isMicMuted(): boolean {
    const tracks = this.localStream?.getAudioTracks() ?? [];

    if (tracks.length === 0) {
      return false;
    }

    return tracks.every((track) => !track.enabled);
  }

  /** Mute/unmute remote participant audio in the remote video element. */
  setRemoteAudioMuted(muted: boolean): void {
    if (this.remoteVideo) {
      this.remoteVideo.muted = muted;
    }
  }

  isRemoteAudioMuted(): boolean {
    return this.remoteVideo?.muted ?? false;
  }

  hangup(): void {
    this.leave();
  }

  leave(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;

    for (const pc of this.peers.values()) {
      pc.close();
    }

    this.peers.clear();

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

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
    }

    this.ws = null;
  }

  private emit(event: VideoClientEvent): void {
    for (const handler of this.handlers) {
      handler(event);
    }
  }

  private wsUrl(): string {
    const wsBase = this.serverUrl.replace(/^http/, "ws");
    return `${wsBase}/v1/signaling?token=${encodeURIComponent(this.token)}`;
  }

  private async connectSignaling(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl());

      const timeout = window.setTimeout(() => {
        reject(new Error("Signaling connection timed out"));
      }, 10_000);

      this.ws.onmessage = (event) => {
        void this.handleServerMessage(String(event.data));
      };

      this.ws.onerror = () => {
        window.clearTimeout(timeout);
        reject(new Error("WebSocket error"));
      };

      this.ws.onopen = () => {
        /* wait for connected message */
      };

      const onConnected = (event: VideoClientEvent) => {
        if (event.type !== "connected") {
          return;
        }

        window.clearTimeout(timeout);
        this.off(onConnected);
        this.send({ type: "join", roomId: this.roomId });
        resolve();
      };

      this.on(onConnected);
    });
  }

  private async startLocalMedia(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("This browser does not support camera/microphone access");
    }

    const isLocalhost =
      window.location.hostname === "localhost" ||
      window.location.hostname === "127.0.0.1";

    if (window.location.protocol !== "https:" && !isLocalhost) {
      throw new Error(
        "Camera/mic blocked on HTTP over LAN. Open the HTTPS demo link (npm run demo:https) and accept the certificate warning once.",
      );
    }

    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: true,
      });
    } catch (error) {
      const name = error instanceof DOMException ? error.name : "Error";
      throw new Error(
        `Could not access camera/mic (${name}). Check browser permission and close other apps using the camera.`,
      );
    }

    if (this.localVideo) {
      this.localVideo.srcObject = this.localStream;
    }
  }

  private send(message: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Signaling socket is not open");
    }

    this.ws.send(JSON.stringify(message));
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

      if (this.remoteVideo) {
        this.remoteVideo.srcObject = stream;
      }

      this.emit({ type: "remote-stream", userId: peerId, stream });
    };

    pc.onicecandidate = (event) => {
      if (!event.candidate) {
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
        this.emit({ type: "peer-left", userId: peerId });
      }
    };

    this.peers.set(peerId, pc);
    return pc;
  }

  private async createOfferTo(peerId: string): Promise<void> {
    const pc = this.getOrCreatePeer(peerId);
    const offer = await pc.createOffer();
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
      case "joined":
        this.emit({
          type: "room-ready",
          roomId: message.roomId,
          participants: message.participants,
        });

        for (const participantId of message.participants) {
          await this.createOfferTo(participantId);
        }

        break;
      case "peer-joined":
        this.emit({ type: "peer-joined", userId: message.userId });
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
        break;
    }
  }

  private async handleOffer(from: string, sdp: string): Promise<void> {
    const pc = this.getOrCreatePeer(from);
    await pc.setRemoteDescription({ type: "offer", sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    this.send({
      type: "answer",
      to: from,
      sdp: answer.sdp,
    });
  }

  private async handleAnswer(from: string, sdp: string): Promise<void> {
    const pc = this.peers.get(from);

    if (!pc) {
      return;
    }

    await pc.setRemoteDescription({ type: "answer", sdp });
  }

  private async handleIceCandidate(
    from: string,
    candidate: RTCIceCandidateInit,
  ): Promise<void> {
    const pc = this.peers.get(from);

    if (!pc) {
      return;
    }

    await pc.addIceCandidate(candidate);
  }
}
