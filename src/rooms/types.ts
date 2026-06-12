export type RoomMode = "p2p" | "sfu";

export type JoinStatus = "admitted" | "waiting";

export interface RoomParticipant {
  userId: string;
  joinedAt: Date;
  displayName?: string;
}

export interface ParticipantInfo {
  userId: string;
  displayName: string;
}

export interface Room {
  id: string;
  createdAt: Date;
  /** Admitted participants (in the meeting / SFU). */
  participants: Map<string, RoomParticipant>;
  /** Waiting for host approval (SFU meetings only). */
  waitingParticipants: Map<string, RoomParticipant>;
  mode: RoomMode;
  code?: string;
  createdBy?: string;
  title?: string;
  expiresAt?: Date;
}

export interface RoomStore {
  create(options?: { mode?: RoomMode; createdBy?: string; title?: string; code?: string }): Room;
  get(roomId: string): Room | undefined;
  getByCode(code: string): Room | undefined;
  addParticipant(roomId: string, userId: string, displayName?: string): Room | null;
  addWaitingParticipant(roomId: string, userId: string, displayName?: string): Room | null;
  admitWaitingParticipant(roomId: string, userId: string): Room | null;
  removeParticipant(roomId: string, userId: string): boolean;
  removeWaitingParticipant(roomId: string, userId: string): boolean;
  hasParticipant(roomId: string, userId: string): boolean;
  hasWaitingParticipant(roomId: string, userId: string): boolean;
  listParticipantIds(roomId: string): string[];
  listWaitingParticipantIds(roomId: string): string[];
  getParticipant(roomId: string, userId: string): RoomParticipant | undefined;
  getWaitingParticipant(roomId: string, userId: string): RoomParticipant | undefined;
  listParticipants(roomId: string): RoomParticipant[];
  listWaitingParticipants(roomId: string): RoomParticipant[];
  countParticipants(roomId: string): number;
}

export type RoomErrorCode =
  | "room_not_found"
  | "already_joined"
  | "room_full"
  | "meeting_not_found"
  | "meeting_expired"
  | "not_admitted"
  | "not_host"
  | "not_waiting"
  | "already_admitted";

export class RoomError extends Error {
  constructor(
    readonly code: RoomErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RoomError";
  }
}
