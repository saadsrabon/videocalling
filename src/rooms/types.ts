export interface RoomParticipant {
  userId: string;
  joinedAt: Date;
}

export interface Room {
  id: string;
  createdAt: Date;
  participants: Map<string, RoomParticipant>;
}

export interface RoomStore {
  create(): Room;
  get(roomId: string): Room | undefined;
  addParticipant(roomId: string, userId: string): Room | null;
  hasParticipant(roomId: string, userId: string): boolean;
  listParticipantIds(roomId: string): string[];
}

export type RoomErrorCode = "room_not_found" | "already_joined";

export class RoomError extends Error {
  constructor(
    readonly code: RoomErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RoomError";
  }
}
