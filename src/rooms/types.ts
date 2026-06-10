export type RoomMode = "p2p" | "sfu";

export interface RoomParticipant {
  userId: string;
  joinedAt: Date;
  displayName?: string;
}

export interface Room {
  id: string;
  createdAt: Date;
  participants: Map<string, RoomParticipant>;
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
  removeParticipant(roomId: string, userId: string): boolean;
  hasParticipant(roomId: string, userId: string): boolean;
  listParticipantIds(roomId: string): string[];
  countParticipants(roomId: string): number;
}

export type RoomErrorCode =
  | "room_not_found"
  | "already_joined"
  | "room_full"
  | "meeting_not_found"
  | "meeting_expired";

export class RoomError extends Error {
  constructor(
    readonly code: RoomErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RoomError";
  }
}
