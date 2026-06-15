import {
  AudioPresets,
  ConnectionState,
  LocalVideoTrack,
  Room,
  RoomEvent,
  Track,
  VideoPresets,
  type LocalTrack,
  type RemoteTrack,
} from "livekit-client";
import {
  BackgroundProcessor,
  supportsBackgroundProcessors,
  type BackgroundProcessorWrapper,
} from "@livekit/track-processors";
import type {
  BackgroundEffectMode,
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
      type: "joined";
      roomId: string;
      participants: string[];
      roster: ParticipantInfo[];
      hostUserId?: string | null;
    }
  | {
      type: "peer-joined";
      userId: string;
      displayName?: string;
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
  | {
      type: "meeting.ended";
      roomId: string;
      reason: "expired" | "ended";
      message?: string;
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
  private displayName = "";
  private resolveSignalingIdentity: (() => void) | null = null;
  private signalingIdentityReady: Promise<void> | null = null;
  private lobbyAdmittedResolve: (() => void) | null = null;
  private lobbyAdmittedReject: ((error: Error) => void) | null = null;
  private lobbyAdmittedPending = false;
  private readonly seenRemotePeerIds = new Set<string>();
  private closed = false;
  private readonly remoteAudioElements = new Map<string, HTMLAudioElement>();
  private waitingLiveKitPreconnected = false;
  private admissionPollTimer: ReturnType<typeof setInterval> | null = null;
  private backgroundProcessor: BackgroundProcessorWrapper | null = null;
  private backgroundEffectMode: BackgroundEffectMode = "none";

  private static readonly audioCaptureOptions = {
    autoGainControl: true,
    echoCancellation: true,
    noiseSuppression: true,
  } as const;

  private static createRoom(): Room {
    return new Room({
      adaptiveStream: true,
      dynacast: true,
      audioCaptureDefaults: LiveKitMeetingClient.audioCaptureOptions,
      videoCaptureDefaults: {
        resolution: VideoPresets.h720.resolution,
      },
      publishDefaults: {
        audioPreset: AudioPresets.speech,
        dtx: true,
        red: true,
      },
    });
  }

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

  attachRemoteAudio(userId: string, element: HTMLAudioElement): void {
    this.remoteAudioElements.set(userId, element);
    element.autoplay = true;
    element.setAttribute("playsinline", "true");

    const participant = this.lkRoom?.remoteParticipants.get(userId);
    const publication = participant?.getTrackPublication(Track.Source.Microphone);
    const track = publication?.track;
    if (track) {
      track.attach(element);
    }
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
    void this.lkRoom?.localParticipant.setMicrophoneEnabled(
      !muted,
      LiveKitMeetingClient.audioCaptureOptions,
    );
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

  async setBackgroundEffect(
    mode: BackgroundEffectMode,
    imageUrl?: string,
  ): Promise<void> {
    if (!supportsBackgroundProcessors()) {
      throw new Error("Background effects are not supported in this browser");
    }

    const videoTrack = this.getLocalCameraTrack();
    if (!videoTrack) {
      throw new Error("Turn on your camera before applying a background effect");
    }

    if (!this.backgroundProcessor) {
      this.backgroundProcessor = BackgroundProcessor({ mode: "disabled" });
      await videoTrack.setProcessor(this.backgroundProcessor);
    }

    if (mode === "none") {
      await this.backgroundProcessor.switchTo({ mode: "disabled" });
      this.backgroundEffectMode = "none";
      return;
    }

    if (mode === "blur") {
      await this.backgroundProcessor.switchTo({
        mode: "background-blur",
        blurRadius: 12,
      });
      this.backgroundEffectMode = "blur";
      return;
    }

    if (!imageUrl?.trim()) {
      throw new Error("Background image URL is required");
    }

    await this.backgroundProcessor.switchTo({
      mode: "virtual-background",
      imagePath: imageUrl.trim(),
    });
    this.backgroundEffectMode = "image";
  }

  getBackgroundEffectMode(): BackgroundEffectMode {
    return this.backgroundEffectMode;
  }

  private getLocalCameraTrack(): LocalVideoTrack | null {
    const track = this.lkRoom?.localParticipant.getTrackPublication(
      Track.Source.Camera,
    )?.track;
    return track instanceof LocalVideoTrack ? track : null;
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
    this.displayName = options.displayName ?? "";
    this.ghostMode = options.ghostMode === true;

    const tokenUserId = this.parseUserIdFromToken(this.token);
    if (tokenUserId) {
      this._userId = tokenUserId;
    }

    const joinResponse = await this.httpJoin(options);
    this.roomId = joinResponse.roomId;
    this.hostUserId = joinResponse.hostUserId;
    this.joinStatus = joinResponse.status;
    for (const participant of joinResponse.participants) {
      this.roster.set(participant.userId, participant.displayName);
      if (participant.userId !== this._userId) {
        this.seenRemotePeerIds.add(participant.userId);
      }
    }

    const lobbyAdmittedPromise =
      joinResponse.status === "waiting"
        ? this.waitForLobbyAdmitted()
        : null;

    await this.connectSignaling();
    await this.waitForSignalingIdentity();

    if (lobbyAdmittedPromise) {
      this.startAdmissionPoll();
      void this.preconnectLiveKitWhileWaiting(this.displayName);
      try {
        await lobbyAdmittedPromise;
        await this.activateLiveKitAfterAdmit(this.displayName);
      } finally {
        this.stopAdmissionPoll();
      }
      const roster = this.getParticipantRoster();
      this.emit({
        type: "joined",
        roomId: joinResponse.roomId,
        participants: roster
          .map((participant) => participant.userId)
          .filter((userId) => userId !== this._userId),
        roster,
        hostUserId: this.hostUserId,
      });
      return joinResponse;
    }

    await this.connectLiveKitRoom({
      displayName: options.displayName,
      allowPublish: true,
    });
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
    this.closed = true;
    this.stopAdmissionPoll();
    this.lobbyAdmittedPending = false;
    this.waitingLiveKitPreconnected = false;
    this.backgroundProcessor = null;
    this.backgroundEffectMode = "none";
    this.seenRemotePeerIds.clear();
    this.lobbyAdmittedReject?.(new Error("Left the meeting"));
    this.lobbyAdmittedResolve = null;
    this.lobbyAdmittedReject = null;

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
    this.remoteAudioElements.clear();

    this.emit({ type: "connection-state", state: "disconnected" });
  }

  async endMeetingForAll(): Promise<void> {
    if (!this.isHost) {
      throw new Error("Only the meeting host can end the meeting for everyone");
    }

    const response = await fetch(
      `${this.serverUrl}/v1/meetings/${encodeURIComponent(this.code)}/end`,
      {
        method: "POST",
        headers: authHeaders(this.token),
      },
    );

    if (!response.ok) {
      throw new Error(`End meeting failed (${response.status})`);
    }

    await this.handleMeetingEnded("ended", "The host ended this meeting.");
  }

  private async handleMeetingEnded(
    reason: "expired" | "ended",
    message?: string,
  ): Promise<void> {
    if (this.closed) {
      return;
    }

    this.emit({ type: "meeting-ended", reason, message });
    await this.leave();
  }

  private waitForLobbyAdmitted(timeoutMs = 300_000): Promise<void> {
    if (this.lobbyAdmittedPending) {
      this.lobbyAdmittedPending = false;
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.lobbyAdmittedReject) {
          return;
        }

        this.lobbyAdmittedResolve = null;
        this.lobbyAdmittedReject(new Error("Timed out waiting for the host to admit you"));
        this.lobbyAdmittedReject = null;
      }, timeoutMs);

      this.lobbyAdmittedResolve = () => {
        clearTimeout(timer);
        resolve();
      };
      this.lobbyAdmittedReject = (error: Error) => {
        clearTimeout(timer);
        reject(error);
      };
    });
  }

  private resolveLobbyAdmission(): void {
    if (this.lobbyAdmittedResolve) {
      this.lobbyAdmittedResolve();
      this.lobbyAdmittedResolve = null;
      this.lobbyAdmittedReject = null;
      return;
    }

    this.lobbyAdmittedPending = true;
  }

  private rejectLobbyAdmission(error: Error): void {
    if (this.lobbyAdmittedReject) {
      this.lobbyAdmittedReject(error);
      this.lobbyAdmittedResolve = null;
      this.lobbyAdmittedReject = null;
      return;
    }

    this.lobbyAdmittedPending = false;
  }

  private applySignalingRoster(roster: ParticipantInfo[]): void {
    for (const participant of roster) {
      this.roster.set(participant.userId, participant.displayName);
      if (participant.userId !== this._userId) {
        this.seenRemotePeerIds.add(participant.userId);
      }
    }
  }

  private handleSignalingJoined(
    message: Extract<ServerMessage, { type: "joined" }>,
  ): void {
    const wasWaiting = this.joinStatus === "waiting";
    this.roomId = message.roomId;
    this.joinStatus = "admitted";
    if (message.hostUserId !== undefined) {
      this.hostUserId = message.hostUserId;
    }
    this.applySignalingRoster(message.roster);
    if (wasWaiting) {
      this.emit({
        type: "lobby-admitted",
        roomId: message.roomId,
        roster: message.roster,
        hostUserId: message.hostUserId ?? this.hostUserId,
      });
    }
    this.resolveLobbyAdmission();
  }

  private emitJoinedFromLobby(message: Extract<
    ServerMessage,
    { type: "lobby.admitted" }
  >): void {
    this.applySignalingRoster(message.roster);

    this.emit({
      type: "lobby-admitted",
      roomId: message.roomId,
      roster: message.roster,
      hostUserId: message.hostUserId ?? this.hostUserId,
    });
  }

  private emitPeerJoined(userId: string, displayName?: string): void {
    if (userId === this._userId || this.seenRemotePeerIds.has(userId)) {
      return;
    }

    this.seenRemotePeerIds.add(userId);
    if (displayName) {
      this.roster.set(userId, displayName);
    }

    this.emit({
      type: "peer-joined",
      userId,
      displayName,
    });
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
    this.signalingIdentityReady = new Promise((resolve) => {
      this.resolveSignalingIdentity = resolve;
    });

    const wsUrl = `${this.serverUrl.replace(/^http/, "ws")}/v1/signaling?token=${encodeURIComponent(this.token)}`;
    this.ws = new WebSocket(wsUrl);
    const earlyMessages: string[] = [];

    await new Promise<void>((resolve, reject) => {
      if (!this.ws) {
        reject(new Error("WebSocket not created"));
        return;
      }

      this.ws.onmessage = (event) => {
        earlyMessages.push(String(event.data));
      };
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error("Signaling connection failed"));
    });

    this.ws.onmessage = (event) => {
      this.handleSignalingMessage(String(event.data));
    };

    for (const raw of earlyMessages) {
      this.handleSignalingMessage(raw);
    }
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
        this.resolveSignalingIdentity?.();
        this.resolveSignalingIdentity = null;
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
        if (message.hostUserId !== undefined) {
          this.hostUserId = message.hostUserId;
        }
        this.emitJoinedFromLobby(message);
        this.resolveLobbyAdmission();
        this.stopAdmissionPoll();
        break;
      case "lobby.denied":
        this.emit({
          type: "lobby-denied",
          roomId: message.roomId,
          message: message.message,
        });
        this.rejectLobbyAdmission(
          new Error(message.message ?? "The host declined your request to join"),
        );
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
      case "joined":
        this.handleSignalingJoined(message);
        break;
      case "peer-joined":
        this.emitPeerJoined(message.userId, message.displayName);
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
      case "meeting.ended":
        void this.handleMeetingEnded(message.reason, message.message);
        break;
      default:
        break;
    }
  }

  private async waitForSignalingIdentity(timeoutMs = 10_000): Promise<void> {
    if (this._userId) {
      return;
    }

    if (!this.signalingIdentityReady) {
      return;
    }

    await Promise.race([
      this.signalingIdentityReady,
      new Promise<void>((_, reject) => {
        setTimeout(
          () => reject(new Error("Signaling identity timeout")),
          timeoutMs,
        );
      }),
    ]);
  }

  private startAdmissionPoll(): void {
    this.stopAdmissionPoll();
    void this.checkAdmissionStatus();

    this.admissionPollTimer = setInterval(() => {
      void this.checkAdmissionStatus();
    }, 1_200);
  }

  private stopAdmissionPoll(): void {
    if (this.admissionPollTimer) {
      clearInterval(this.admissionPollTimer);
      this.admissionPollTimer = null;
    }
  }

  private async checkAdmissionStatus(): Promise<void> {
    if (this.closed || this.joinStatus !== "waiting") {
      this.stopAdmissionPoll();
      return;
    }

    try {
      const payload = await this.fetchLiveKitTokenPayload(this.displayName);
      if (payload.status === "admitted") {
        this.joinStatus = "admitted";
        this.resolveLobbyAdmission();
        this.stopAdmissionPoll();
      }
    } catch {
      /* Ignore transient poll failures. */
    }
  }

  private async fetchLiveKitTokenPayload(
    displayName?: string,
  ): Promise<LiveKitTokenPayload & { roomId?: string; code?: string }> {
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

    return (await response.json()) as LiveKitTokenPayload & {
      roomId?: string;
      code?: string;
    };
  }

  private async preconnectLiveKitWhileWaiting(displayName?: string): Promise<void> {
    if (this.joinStatus !== "waiting" || this.lkRoom || this.closed) {
      return;
    }

    try {
      await this.connectLiveKitRoom({
        displayName,
        allowPublish: false,
      });
      this.waitingLiveKitPreconnected = true;
    } catch {
      this.waitingLiveKitPreconnected = false;
    }
  }

  private async activateLiveKitAfterAdmit(displayName?: string): Promise<void> {
    this.joinStatus = "admitted";

    if (
      this.lkRoom?.state === ConnectionState.Connected &&
      this.waitingLiveKitPreconnected
    ) {
      try {
        if (!this.ghostMode) {
          await this.publishLocalMedia(this.lkRoom);
        } else {
          this.emit({ type: "media-ready" });
        }
        this.waitingLiveKitPreconnected = false;
        return;
      } catch {
        await this.lkRoom.disconnect();
        this.lkRoom = null;
        this.waitingLiveKitPreconnected = false;
      }
    }

    await this.connectLiveKitRoom({
      displayName,
      allowPublish: true,
    });
  }

  private attachLiveKitRoomHandlers(room: Room): void {
    const emitVideoTrack = (
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
      this.emitPeerJoined(participant.identity, participant.name);
    });

    room.on(RoomEvent.ParticipantDisconnected, (participant) => {
      this.seenRemotePeerIds.delete(participant.identity);
      this.emit({ type: "peer-left", userId: participant.identity });
    });

    room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      if (track.kind === Track.Kind.Audio) {
        const audioElement = this.remoteAudioElements.get(participant.identity);
        if (audioElement) {
          track.attach(audioElement);
        }

        const stream = new MediaStream([track.mediaStreamTrack]);
        this.emit({
          type: "track-added",
          peerId: participant.identity,
          kind: "audio",
          source: "camera",
          track: track.mediaStreamTrack,
          stream,
        });
        return;
      }

      const source: MediaSource =
        publication.source === Track.Source.ScreenShare ? "screen" : "camera";
      emitVideoTrack(participant.identity, track, source);
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
        emitVideoTrack(this._userId, track, "screen");
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
  }

  private async connectLiveKitRoom(options: {
    displayName?: string;
    allowPublish: boolean;
  }): Promise<void> {
    if (this.lkRoom?.state === ConnectionState.Connected) {
      if (options.allowPublish && !this.ghostMode) {
        await this.publishLocalMedia(this.lkRoom);
      }
      return;
    }

    const payload = await this.fetchLiveKitTokenPayload(options.displayName);
    const room = LiveKitMeetingClient.createRoom();
    this.attachLiveKitRoomHandlers(room);

    this.emit({ type: "media-syncing" });
    this.emit({ type: "connection-state", state: "connecting" });
    await Promise.race([
      room.connect(payload.server_url, payload.participant_token),
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error("LiveKit connection timed out")),
          25_000,
        );
      }),
    ]);
    this.lkRoom = room;

    try {
      await room.startAudio();
    } catch {
      /* Browser may block until user gesture — tracks still attach. */
    }

    if (!options.allowPublish || this.ghostMode) {
      this.emit({ type: "media-ready" });
      return;
    }

    await this.publishLocalMedia(room);
  }

  private async initBackgroundProcessor(): Promise<void> {
    if (
      this.ghostMode ||
      this.backgroundProcessor ||
      !supportsBackgroundProcessors()
    ) {
      return;
    }

    const videoTrack = this.getLocalCameraTrack();
    if (!videoTrack) {
      return;
    }

    this.backgroundProcessor = BackgroundProcessor({ mode: "disabled" });
    await videoTrack.setProcessor(this.backgroundProcessor);
  }

  private async publishLocalMedia(room: Room): Promise<void> {
    let hasVideo = false;
    let hasAudio = false;
    const captureOptions = LiveKitMeetingClient.audioCaptureOptions;

    try {
      await room.localParticipant.setMicrophoneEnabled(true, captureOptions);
      this.micMuted = false;
      hasAudio = true;

      try {
        await room.localParticipant.setCameraEnabled(true, {
          resolution: VideoPresets.h720.resolution,
        });
        this.cameraOff = false;
        hasVideo = true;
      } catch {
        this.cameraOff = true;
      }

      this.localStream = this.collectLocalMediaStream(room);
      if (this.localStream) {
        this.emit({ type: "local-stream-ready", stream: this.localStream });
      }

      await this.initBackgroundProcessor();
    } catch {
      try {
        await room.localParticipant.setMicrophoneEnabled(true, captureOptions);
        this.micMuted = false;
        hasAudio = true;
        this.localStream = this.collectLocalMediaStream(room);
        if (this.localStream) {
          this.emit({ type: "local-stream-ready", stream: this.localStream });
        }
      } catch {
        this.localStream = null;
      }

      this.emit({
        type: "local-media-fallback",
        hasVideo,
        hasAudio,
        message:
          hasAudio || hasVideo
            ? "Some media devices could not be accessed."
            : "Camera and microphone are unavailable. You can still listen and chat.",
      });
    }

    this.emit({ type: "media-ready" });
  }

  private collectLocalMediaStream(room: Room): MediaStream | null {
    const stream = new MediaStream();
    const micTrack = room.localParticipant.getTrackPublication(
      Track.Source.Microphone,
    )?.track?.mediaStreamTrack;
    const cameraTrack = room.localParticipant.getTrackPublication(
      Track.Source.Camera,
    )?.track?.mediaStreamTrack;

    if (micTrack) {
      stream.addTrack(micTrack);
    }
    if (cameraTrack) {
      stream.addTrack(cameraTrack);
    }

    return stream.getTracks().length > 0 ? stream : null;
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

  private parseUserIdFromToken(token: string): string | null {
    try {
      const payload = JSON.parse(atob(token.split(".")[1] ?? "")) as {
        userId?: string;
        sub?: string;
      };
      const userId = payload.userId ?? payload.sub;
      return typeof userId === "string" && userId.length > 0 ? userId : null;
    } catch {
      return null;
    }
  }
}
