import {
  ConnectionState,
  Room,
  RoomEvent,
  Track,
  createLocalTracks,
  type RemoteTrack,
  type LocalTrack,
} from "livekit-client";
import type {
  GuestTokenResponse,
  MediaSource,
  MeetingChatMessage,
  MeetingClientEvent,
  MeetingClientEventHandler,
  MeetingClientJoinOptions,
  MeetingCreateResponse,
  MeetingJoinResponse,
  MeetingJoinStatus,
  ParticipantInfo,
} from "./types.js";
import { authHeaders, normalizeServerUrl, normalizeToken } from "./http.js";

type ServerMessage =
  | { type: "connected"; userId: string }
  | { type: "lobby.waiting"; roomId: string; hostUserId: string | null }
  | {
      type: "lobby.admitted";
      roomId: string;
      roster: ParticipantInfo[];
      hostUserId?: string | null;
    }
  | { type: "lobby.denied"; roomId: string; message?: string }
  | {
      type: "lobby.request";
      roomId: string;
      userId: string;
      displayName: string;
    }
  | { type: "lobby.list"; roomId: string; waiting: ParticipantInfo[] }
  | {
      type: "meeting.chat";
      roomId: string;
      id: string;
      from: string;
      displayName: string;
      text: string;
      sentAt: string;
    }
  | { type: "error"; code: string; message: string };

interface LiveKitTokenPayload {
  server_url: string;
  participant_token: string;
  status?: "admitted" | "waiting";
}

export class LiveKitMeetingClient {
  private readonly serverUrl: string;
  private readonly getToken: () => Promise<string> | string;
  private token = "";
  private _userId = "";
  private roomId = "";
  private code = "";
  private hostUserId: string | null = null;
  private joinStatus: MeetingJoinStatus = "admitted";
  private ghostMode = false;
  private ws: WebSocket | null = null;
  private lkRoom: Room | null = null;
  private localStream: MediaStream | null = null;
  private readonly handlers = new Set<MeetingClientEventHandler>();
  private readonly chatHistory: MeetingChatMessage[] = [];
  private readonly roster = new Map<string, string>();
  private micMuted = false;
  private cameraOff = false;

  private constructor(
    serverUrl: string,
    getToken: () => Promise<string> | string,
  ) {
    this.serverUrl = normalizeServerUrl(serverUrl);
    this.getToken = getToken;
  }

  static create(options: {
    serverUrl: string;
    getToken: () => Promise<string> | string;
  }): LiveKitMeetingClient {
    return new LiveKitMeetingClient(options.serverUrl, options.getToken);
  }

  static async join(
    options: MeetingClientJoinOptions,
    onEvent?: MeetingClientEventHandler,
  ): Promise<LiveKitMeetingClient> {
    const client = new LiveKitMeetingClient(
      options.serverUrl,
      () => options.token,
    );
    if (onEvent) {
      client.on(onEvent);
    }
    await client.join(options);
    return client;
  }

  get userId(): string {
    return this._userId;
  }

  get isHost(): boolean {
    return this.hostUserId === this._userId;
  }

  get currentJoinStatus(): MeetingJoinStatus {
    return this.joinStatus;
  }

  get localMediaStream(): MediaStream | null {
    return this.localStream;
  }

  getDisplayName(userId: string): string {
    return this.roster.get(userId) ?? userId;
  }

  getParticipantRoster(): ParticipantInfo[] {
    return [...this.roster.entries()].map(([userId, displayName]) => ({
      userId,
      displayName,
    }));
  }

  on(handler: MeetingClientEventHandler): void {
    this.handlers.add(handler);
    if (this.chatHistory.length > 0) {
      handler({ type: "chat-history-replay", messages: [...this.chatHistory] });
    }
  }

  off(handler: MeetingClientEventHandler): void {
    this.handlers.delete(handler);
  }

  setMicMuted(muted: boolean): void {
    this.micMuted = muted;
    void this.lkRoom?.localParticipant.setMicrophoneEnabled(!muted);
  }

  isMicMuted(): boolean {
    return this.micMuted;
  }

  setCameraOff(off: boolean): void {
    this.cameraOff = off;
    void this.lkRoom?.localParticipant.setCameraEnabled(!off);
  }

  isCameraOff(): boolean {
    return this.cameraOff;
  }

  listWaitingParticipants(): void {
    this.listWaiting();
  }

  async setVideoSource(track: MediaStreamTrack): Promise<void> {
    if (!this.lkRoom) {
      return;
    }

    const existing = this.lkRoom.localParticipant.getTrackPublication(
      Track.Source.Camera,
    )?.track;

    if (existing) {
      await this.lkRoom.localParticipant.unpublishTrack(existing);
    }

    await this.lkRoom.localParticipant.publishTrack(track);
    if (this.localStream) {
      const old = this.localStream.getVideoTracks()[0];
      if (old) {
        this.localStream.removeTrack(old);
      }
      this.localStream.addTrack(track);
    }
  }

  private emit(event: MeetingClientEvent): void {
    for (const handler of this.handlers) {
      handler(event);
    }
  }

  async createMeeting(
    title?: string,
    durationMinutes?: number,
  ): Promise<MeetingCreateResponse> {
    this.token = normalizeToken(await this.getToken());
    const response = await fetch(`${this.serverUrl}/v1/meetings`, {
      method: "POST",
      headers: {
        ...authHeaders(this.token),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title, durationMinutes }),
    });

    if (!response.ok) {
      throw new Error(`Create meeting failed (${response.status})`);
    }

    return (await response.json()) as MeetingCreateResponse;
  }

  async requestGuestToken(
    code: string,
    name: string,
  ): Promise<GuestTokenResponse> {
    const response = await fetch(
      `${this.serverUrl}/v1/meetings/${encodeURIComponent(code)}/guest-token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      },
    );

    if (!response.ok) {
      throw new Error(`Guest token failed (${response.status})`);
    }

    return (await response.json()) as GuestTokenResponse;
  }

  async join(options: MeetingClientJoinOptions): Promise<MeetingJoinResponse> {
    this.token = normalizeToken(options.token ?? (await this.getToken()));
    this.code = options.code;
    this.ghostMode = options.ghostMode === true;

    const joinResponse = await this.httpJoin(options);
    this.roomId = joinResponse.roomId;
    this.hostUserId = joinResponse.hostUserId;
    this.joinStatus = joinResponse.status;
    for (const participant of joinResponse.participants) {
      this.roster.set(participant.userId, participant.displayName);
    }

    await this.connectSignaling();

    if (joinResponse.status === "waiting") {
      this.emit({
        type: "lobby-waiting",
        roomId: joinResponse.roomId,
        hostUserId: joinResponse.hostUserId,
      });
      return joinResponse;
    }

    await this.connectLiveKit(options.displayName);
    this.emit({
      type: "joined",
      roomId: joinResponse.roomId,
      participants: joinResponse.participants.map((p) => p.userId),
      roster: joinResponse.participants,
      hostUserId: joinResponse.hostUserId,
    });

    return joinResponse;
  }

  async leave(): Promise<void> {
    if (this.lkRoom) {
      await this.lkRoom.disconnect();
      this.lkRoom = null;
    }

    this.ws?.close();
    this.ws = null;

    for (const track of this.localStream?.getTracks() ?? []) {
      track.stop();
    }
    this.localStream = null;

    this.emit({ type: "connection-state", state: "disconnected" });
  }

  async toggleMic(enabled?: boolean): Promise<boolean> {
    const next = enabled ?? this.micMuted;
    this.setMicMuted(!next);
    return !this.micMuted;
  }

  async toggleCam(enabled?: boolean): Promise<boolean> {
    const next = enabled ?? this.cameraOff;
    this.setCameraOff(!next);
    return !this.cameraOff;
  }

  async startScreenShare(): Promise<void> {
    if (!this.lkRoom) {
      return;
    }
    await this.lkRoom.localParticipant.setScreenShareEnabled(true);
    this.emit({ type: "screen-share-started" });
  }

  async stopScreenShare(): Promise<void> {
    if (!this.lkRoom) {
      return;
    }
    await this.lkRoom.localParticipant.setScreenShareEnabled(false);
    this.emit({ type: "screen-share-stopped" });
  }

  sendChat(text: string): void {
    const trimmed = text.trim();
    if (!trimmed || !this.roomId) {
      return;
    }

    this.wsSend({
      type: "meeting.chat.send",
      roomId: this.roomId,
      text: trimmed,
      v: 1,
    });
  }

  admitParticipant(userId: string): void {
    this.wsSend({
      type: "lobby.admit",
      roomId: this.roomId,
      userId,
      v: 1,
    });
  }

  denyParticipant(userId: string): void {
    this.wsSend({
      type: "lobby.deny",
      roomId: this.roomId,
      userId,
      v: 1,
    });
  }

  listWaiting(): void {
    this.wsSend({ type: "lobby.list", roomId: this.roomId, v: 1 });
  }

  getLocalStream(): MediaStream | null {
    return this.localStream;
  }

  attachLocalVideo(element: HTMLVideoElement): void {
    const track = this.lkRoom?.localParticipant.getTrackPublication(
      Track.Source.Camera,
    )?.track;
    if (track) {
      track.attach(element);
    }
  }

  attachRemoteVideo(userId: string, element: HTMLVideoElement): void {
    const participant = this.lkRoom?.remoteParticipants.get(userId);
    const pub =
      participant?.getTrackPublication(Track.Source.Camera) ??
      participant?.getTrackPublication(Track.Source.ScreenShare);
    if (pub?.track) {
      pub.track.attach(element);
    }
  }

  getChatHistory(): MeetingChatMessage[] {
    return [...this.chatHistory];
  }

  private async httpJoin(
    options: MeetingClientJoinOptions,
  ): Promise<MeetingJoinResponse> {
    const isGuest = this.isGuestToken(options.token);
    const path = isGuest
      ? `/v1/meetings/${encodeURIComponent(options.code)}/guest-join`
      : `/v1/meetings/${encodeURIComponent(options.code)}/join`;

    const body = isGuest
      ? { token: options.token, displayName: options.displayName }
      : { displayName: options.displayName, ghost: options.ghostMode };

    const response = await fetch(`${this.serverUrl}${path}`, {
      method: "POST",
      headers: {
        ...(isGuest ? {} : authHeaders(this.token)),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Join failed (${response.status})`);
    }

    return (await response.json()) as MeetingJoinResponse;
  }

  private async connectSignaling(): Promise<void> {
    const wsUrl = `${this.serverUrl.replace(/^http/, "ws")}/v1/signaling?token=${encodeURIComponent(this.token)}`;
    this.ws = new WebSocket(wsUrl);

    await new Promise<void>((resolve, reject) => {
      if (!this.ws) {
        reject(new Error("WebSocket not created"));
        return;
      }

      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error("Signaling connection failed"));
    });

    this.ws.onmessage = (event) => {
      this.handleSignalingMessage(String(event.data));
    };
  }

  private handleSignalingMessage(raw: string): void {
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
        this.wsSend({ type: "join", roomId: this.roomId, v: 1 });
        break;
      case "lobby.waiting":
        this.joinStatus = "waiting";
        this.emit({
          type: "lobby-waiting",
          roomId: message.roomId,
          hostUserId: message.hostUserId,
        });
        break;
      case "lobby.admitted":
        this.joinStatus = "admitted";
        void this.onAdmitted(message);
        break;
      case "lobby.denied":
        this.emit({
          type: "lobby-denied",
          roomId: message.roomId,
          message: message.message,
        });
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
        this.emit({ type: "lobby-waiting-list", waiting: message.waiting });
        break;
      case "meeting.chat": {
        const chat: MeetingChatMessage = {
          id: message.id,
          from: message.from,
          displayName: message.displayName,
          text: message.text,
          sentAt: message.sentAt,
        };
        this.chatHistory.push(chat);
        this.emit({ type: "chat-message", ...chat });
        break;
      }
      default:
        break;
    }
  }

  private async onAdmitted(message: Extract<
    ServerMessage,
    { type: "lobby.admitted" }
  >): Promise<void> {
    this.emit({
      type: "lobby-admitted",
      roomId: message.roomId,
      roster: message.roster,
      hostUserId: message.hostUserId ?? this.hostUserId,
    });

    await this.connectLiveKit();
    this.emit({
      type: "joined",
      roomId: message.roomId,
      participants: message.roster.map((p) => p.userId),
      roster: message.roster,
      hostUserId: message.hostUserId ?? this.hostUserId,
    });
  }

  private async connectLiveKit(displayName?: string): Promise<void> {
    if (this.joinStatus !== "admitted") {
      return;
    }

    const isGuest = this.isGuestToken(this.token);
    const tokenPath = isGuest
      ? `/v1/meetings/${encodeURIComponent(this.code)}/guest-livekit-token`
      : `/v1/meetings/${encodeURIComponent(this.code)}/livekit-token`;

    const response = await fetch(`${this.serverUrl}${tokenPath}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(isGuest ? {} : authHeaders(this.token)),
      },
      body: JSON.stringify(
        isGuest
          ? { token: this.token }
          : displayName
            ? { displayName }
            : {},
      ),
    });

    if (!response.ok) {
      throw new Error(`LiveKit token failed (${response.status})`);
    }

    const payload = (await response.json()) as LiveKitTokenPayload;
    const room = new Room({ adaptiveStream: true, dynacast: true });

    const emitTrack = (
      peerId: string,
      track: RemoteTrack | LocalTrack,
      source: MediaSource,
    ): void => {
      const kind = track.kind === Track.Kind.Audio ? "audio" : "video";
      const stream = new MediaStream([track.mediaStreamTrack]);
      this.emit({
        type: "track-added",
        peerId,
        kind,
        source,
        track: track.mediaStreamTrack,
        stream,
      });
    };

    room.on(RoomEvent.ConnectionStateChanged, (state: ConnectionState) => {
      const mapped =
        state === ConnectionState.Connected
          ? "connected"
          : state === ConnectionState.Reconnecting
            ? "reconnecting"
            : state === ConnectionState.Disconnected
              ? "disconnected"
              : "connecting";
      this.emit({ type: "connection-state", state: mapped });
    });

    room.on(RoomEvent.ParticipantConnected, (participant) => {
      if (participant.name) {
        this.roster.set(participant.identity, participant.name);
      }
      this.emit({
        type: "peer-joined",
        userId: participant.identity,
        displayName: participant.name,
      });
    });

    room.on(RoomEvent.ParticipantDisconnected, (participant) => {
      this.emit({ type: "peer-left", userId: participant.identity });
    });

    room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      const source: MediaSource =
        publication.source === Track.Source.ScreenShare ? "screen" : "camera";
      emitTrack(participant.identity, track, source);
      this.emit({ type: "media-ready" });
    });

    room.on(RoomEvent.TrackUnsubscribed, (_track, publication, participant) => {
      const source: MediaSource =
        publication.source === Track.Source.ScreenShare ? "screen" : "camera";
      this.emit({
        type: "track-removed",
        peerId: participant.identity,
        producerId: publication.trackSid,
        source,
      });
    });

    room.on(RoomEvent.LocalTrackPublished, (publication) => {
      const track = publication.track;
      if (!track) {
        return;
      }
      if (publication.source === Track.Source.ScreenShare) {
        this.emit({ type: "screen-share-started" });
        emitTrack(this._userId, track, "screen");
      }
    });

    room.on(RoomEvent.LocalTrackUnpublished, (publication) => {
      if (publication.source === Track.Source.ScreenShare) {
        this.emit({ type: "screen-share-stopped" });
        this.emit({
          type: "track-removed",
          peerId: this._userId,
          producerId: publication.trackSid,
          source: "screen",
        });
      }
    });

    this.emit({ type: "media-syncing" });
    this.emit({ type: "connection-state", state: "connecting" });
    await room.connect(payload.server_url, payload.participant_token);
    this.lkRoom = room;

    if (!this.ghostMode) {
      const tracks = await createLocalTracks({ audio: true, video: true });
      this.localStream = new MediaStream();
      for (const track of tracks) {
        this.localStream.addTrack(track.mediaStreamTrack);
        await room.localParticipant.publishTrack(track);
        emitTrack(this._userId, track, "camera");
      }
      this.emit({ type: "local-stream-ready", stream: this.localStream });
    }

    this.emit({ type: "media-ready" });
  }

  private wsSend(payload: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  private isGuestToken(token: string): boolean {
    try {
      const payload = JSON.parse(atob(token.split(".")[1] ?? ""));
      return payload.role === "guest";
    } catch {
      return false;
    }
  }
}
