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
} from "./types.js";
import { authHeaders, jsonPostInit, normalizeServerUrl, normalizeToken } from "./http.js";

type ServerMessage =
  | { type: "connected"; userId: string }
  | {
      type: "joined";
      roomId: string;
      participants: string[];
      mode?: "p2p" | "sfu";
    }
  | { type: "peer-joined"; userId: string }
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

export class MeetingClient {
  private readonly serverUrl: string;
  private readonly token: string;
  private readonly code: string;
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
  private micMuted = false;
  private cameraOff = false;
  private closed = false;

  private readonly pendingRequests = new Map<
    string,
    { resolve: (value: ServerMessage) => void; reject: (error: Error) => void }
  >();
  private requestCounter = 0;

  private readonly remoteTracks = new Map<string, RemoteTrackMeta>();
  private readonly producerIndex = new Map<string, string>();

  private constructor(options: MeetingClientJoinOptions) {
    this.serverUrl = normalizeServerUrl(options.serverUrl);
    this.token = normalizeToken(options.token);
    this.code = options.code.trim().toUpperCase();
  }

  get userId(): string {
    return this._userId;
  }

  get currentRoomId(): string {
    return this.roomId;
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

  async leave(): Promise<void> {
    if (this.closed) {
      return;
    }

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
        this.emit({
          type: "joined",
          roomId: message.roomId,
          participants: message.participants,
        });
        break;
      case "peer-joined":
        this.emit({ type: "peer-joined", userId: message.userId });
        void this.consumeProducer(message.userId, message.userId).catch((error) => {
          this.emit({
            type: "error",
            message: error instanceof Error ? error.message : "Consume failed",
          });
        });
        break;
      case "sfu.peerLeft":
        this.removePeerTracks(message.peerId);
        this.emit({ type: "peer-left", userId: message.peerId });
        break;
      case "sfu.newProducer":
        if (message.peerId === this._userId) {
          return;
        }
        void this.consumeRemoteProducer(
          message.peerId,
          message.producerId,
          message.kind,
          message.appData?.source === "screen" ? "screen" : "camera",
        ).catch((error) => {
          this.emit({
            type: "error",
            message: error instanceof Error ? error.message : "Consume failed",
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

  private async connectAndJoin(_options: MeetingClientJoinOptions): Promise<void> {
    const baseUrl = this.serverUrl;
    const headers = authHeaders(this.token);

    const iceResponse = await fetch(`${baseUrl}/v1/ice-servers`, { headers });
    if (!iceResponse.ok) {
      throw new Error(`Failed to fetch ICE servers (${iceResponse.status})`);
    }

    void ((await iceResponse.json()) as IceServersResponse);

    const joinResponse = await fetch(
      `${baseUrl}/v1/meetings/${encodeURIComponent(this.code)}/join`,
      {
        method: "POST",
        ...jsonPostInit(this.token),
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
          body: JSON.stringify({ token: this.token }),
        },
      );

      if (!guestJoin.ok) {
        throw new Error(`Failed to join meeting (${joinResponse.status})`);
      }

      const guestResult = (await guestJoin.json()) as MeetingJoinResponse;
      this.roomId = guestResult.roomId;
    } else {
      const joinResult = (await joinResponse.json()) as MeetingJoinResponse;
      this.roomId = joinResult.roomId;
    }

    await this.openSignaling();
    await this.waitForJoined();
    await this.startMediasoupSession();
  }

  private openSignaling(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wsUrl = new URL(`${this.serverUrl}/v1/signaling`);
      wsUrl.searchParams.set("token", this.token);
      this.ws = new WebSocket(wsUrl.toString());

      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error("WebSocket connection failed"));
      this.ws.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as ServerMessage;
        this.handleServerMessage(message);
      };
    });
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

  private async startMediasoupSession(): Promise<void> {
    const capsMessage = (await this.request("sfu.getRtpCapabilities", {
      roomId: this.roomId,
    })) as Extract<ServerMessage, { type: "sfu.rtpCapabilities" }>;

    this.device = new Device();
    await this.device.load({
      routerRtpCapabilities: capsMessage.rtpCapabilities as never,
    });

    await this.createSendTransport();
    await this.createRecvTransport();
    await this.startLocalMedia();

    const existingProducers = await this.listExistingProducers();
    for (const producer of existingProducers) {
      await this.consumeRemoteProducer(
        producer.peerId,
        producer.producerId,
        producer.kind,
        producer.source,
      );
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

  private async consumeProducer(_peerId: string, _userId: string): Promise<void> {
    /* producers arrive via sfu.newProducer or sfu.listProducers */
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
    this.localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: true,
    });

    const audioTrack = this.localStream.getAudioTracks()[0];
    const videoTrack = this.customVideoTrack ?? this.localStream.getVideoTracks()[0];

    if (audioTrack && this.sendTransport) {
      this.micProducer = await this.sendTransport.produce({
        track: audioTrack,
        appData: { source: "camera" },
      });
    }

    if (videoTrack && this.sendTransport) {
      this.cameraProducer = await this.sendTransport.produce({
        track: videoTrack,
        appData: { source: "camera" },
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
      return;
    }

    if (this.remoteTracks.has(producerId)) {
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

    const stream = new MediaStream([consumer.track]);
    const resolvedSource =
      consumed.appData?.source === "screen" ? "screen" : source;

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
