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
}

export interface MeetingJoinResponse {
  roomId: string;
  mode: "p2p" | "sfu";
  code?: string;
  participants: string[];
  alreadyJoined: boolean;
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
}

export type MediaSource = "camera" | "screen";

export type MeetingClientEvent =
  | { type: "connected"; userId: string }
  | { type: "joined"; roomId: string; participants: string[] }
  | { type: "peer-joined"; userId: string }
  | { type: "peer-left"; userId: string }
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
  | { type: "error"; message: string };

export type MeetingClientEventHandler = (event: MeetingClientEvent) => void;
