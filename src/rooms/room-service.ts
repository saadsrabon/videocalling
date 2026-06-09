import type { RoomStore } from "./types.js";
import { RoomError } from "./types.js";

export class RoomService {
  constructor(private readonly store: RoomStore) {}

  create() {
    const room = this.store.create();

    return {
      roomId: room.id,
      createdAt: room.createdAt.toISOString(),
    };
  }

  join(roomId: string, userId: string) {
    const room = this.store.get(roomId);

    if (!room) {
      throw new RoomError("room_not_found", `Room not found: ${roomId}`);
    }

    const alreadyJoined = room.participants.has(userId);
    this.store.addParticipant(roomId, userId);

    return {
      roomId,
      participants: this.store.listParticipantIds(roomId),
      alreadyJoined,
    };
  }

  isParticipant(roomId: string, userId: string): boolean {
    return this.store.hasParticipant(roomId, userId);
  }

  listParticipantIds(roomId: string): string[] {
    return this.store.listParticipantIds(roomId);
  }
}
