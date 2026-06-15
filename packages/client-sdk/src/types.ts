export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface IceServersResponse {
  iceServers: IceServerConfig[];
}

export interface RoomCreateResponse {
  roomId: string;
  createdAt: string;
}

export interface RoomJoinResponse {
  roomId: string;
  participants: string[];
  alreadyJoined: boolean;
}

export interface VideoClientConnectOptions {
  /** Base URL e.g. http://localhost:3004 */
  serverUrl: string;
  token: string;
  /** Existing room — if omitted, a new room is created */
  roomId?: string;
  localVideo?: HTMLVideoElement;
  remoteVideo?: HTMLVideoElement;
}

export interface CallInvitePayload {
  type: "call.invite";
  from: string;
  to: string;
  callId: string;
  roomId: string;
  fromName?: string;
  fromEmail?: string;
}

export type StaffCallState =
  | "idle"
  | "connecting"
  | "outgoing"
  | "incoming"
  | "active";

export interface StaffCallClientOptions {
  serverUrl: string;
  getToken: () => Promise<string>;
  localVideo?: HTMLVideoElement;
  remoteVideo?: HTMLVideoElement;
}

export type StaffCallEvent =
  | { type: "connected"; userId: string }
  | { type: "state-changed"; state: StaffCallState }
  | { type: "incoming-call"; invite: CallInvitePayload }
  | { type: "room-ready"; roomId: string; participants: string[] }
  | { type: "remote-stream"; userId: string; stream: MediaStream }
  | {
      type: "call-ended";
      reason: "ended" | "rejected" | "cancelled" | "unavailable";
    }
  | { type: "error"; message: string };

export type StaffCallEventHandler = (event: StaffCallEvent) => void;

export type VideoClientEvent =
  | { type: "connected"; userId: string }
  | { type: "room-ready"; roomId: string; participants: string[] }
  | { type: "peer-joined"; userId: string }
  | { type: "remote-stream"; userId: string; stream: MediaStream }
  | { type: "peer-left"; userId: string }
  | { type: "error"; message: string };

export type VideoClientEventHandler = (event: VideoClientEvent) => void;

export interface MeetingCreateResponse {
  roomId: string;
  code: string;
  createdAt: string;
  title?: string;
  joinUrl: string;
  maxParticipants: number;
  hostUserId?: string;
  durationMinutes?: number;
  expiresAt?: string;
}

export type MeetingJoinStatus = "admitted" | "waiting";

export interface ParticipantInfo {
  userId: string;
  displayName: string;
}

export interface MeetingJoinResponse {
  roomId: string;
  mode: "p2p" | "sfu";
  code?: string;
  status: MeetingJoinStatus;
  hostUserId: string | null;
  participants: ParticipantInfo[];
  alreadyJoined: boolean;
  ghost?: boolean;
  expiresAt?: string;
}

export interface ActiveMeetingSummary {
  roomId: string;
  code: string;
  title?: string;
  hostUserId?: string;
  createdAt: string;
  expiresAt?: string;
  participantCount: number;
  waitingCount: number;
  maxParticipants: number;
}

export interface ActiveMeetingsResponse {
  meetings: ActiveMeetingSummary[];
  maxParticipants: number;
}

export interface GuestTokenResponse {
  token: string;
  userId: string;
  roomId: string;
  code: string;
  expiresIn: number;
}

export interface MeetingClientJoinOptions {
  serverUrl: string;
  token: string;
  /** Meeting join code */
  code: string;
  displayName?: string;
  /** SUPER_ADMIN observer — listen/watch only, invisible to others. */
  ghostMode?: boolean;
}

export type MediaSource = "camera" | "screen";

export type ConnectionQualityLevel = "good" | "degraded" | "poor";

export interface MeetingChatMessage {
  id: string;
  from: string;
  displayName: string;
  text: string;
  sentAt: string;
}

export type MeetingClientEvent =
  | { type: "connected"; userId: string }
  | {
      type: "connection-state";
      state: "connecting" | "connected" | "reconnecting" | "disconnected";
      message?: string;
    }
  | { type: "media-syncing" }
  | { type: "media-ready" }
  | {
      type: "local-media-fallback";
      hasVideo: boolean;
      hasAudio: boolean;
      message: string;
    }
  | { type: "local-stream-ready"; stream: MediaStream }
  | {
      type: "joined";
      roomId: string;
      participants: string[];
      roster: ParticipantInfo[];
      hostUserId: string | null;
    }
  | { type: "peer-joined"; userId: string; displayName?: string }
  | { type: "peer-left"; userId: string }
  | { type: "lobby-waiting"; roomId: string; hostUserId: string | null }
  | {
      type: "lobby-admitted";
      roomId: string;
      roster: ParticipantInfo[];
      hostUserId: string | null;
    }
  | { type: "lobby-denied"; roomId: string; message?: string }
  | {
      type: "lobby-request";
      roomId: string;
      userId: string;
      displayName: string;
    }
  | { type: "lobby-waiting-list"; waiting: ParticipantInfo[] }
  | { type: "participant-roster"; roster: ParticipantInfo[] }
  | {
      type: "chat-message";
      id: string;
      from: string;
      displayName: string;
      text: string;
      sentAt: string;
    }
  | { type: "chat-history-replay"; messages: MeetingChatMessage[] }
  | {
      type: "connection-quality";
      level: ConnectionQualityLevel;
      message?: string;
      packetLossPercent?: number;
      rttMs?: number;
    }
  | {
      type: "audio-only-fallback";
      active: boolean;
      message?: string;
    }
  | {
      type: "track-added";
      peerId: string;
      kind: "audio" | "video";
      source: MediaSource;
      track: MediaStreamTrack;
      stream: MediaStream;
    }
  | {
      type: "track-removed";
      peerId: string;
      producerId: string;
      source?: MediaSource;
    }
  | { type: "screen-share-started" }
  | { type: "screen-share-stopped" }
  | {
      type: "transport-state";
      direction: "send" | "recv";
      state: string;
      message: string;
    }
  | { type: "meeting-expiring"; minutesRemaining: number }
  | {
      type: "meeting-ended";
      reason: "expired" | "ended";
      message?: string;
    }
  | { type: "error"; message: string };

export type MeetingClientEventHandler = (event: MeetingClientEvent) => void;
