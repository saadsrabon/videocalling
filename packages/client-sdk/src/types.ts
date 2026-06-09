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

export type VideoClientEvent =
  | { type: "connected"; userId: string }
  | { type: "room-ready"; roomId: string; participants: string[] }
  | { type: "peer-joined"; userId: string }
  | { type: "remote-stream"; userId: string; stream: MediaStream }
  | { type: "peer-left"; userId: string }
  | { type: "error"; message: string };

export type VideoClientEventHandler = (event: VideoClientEvent) => void;
