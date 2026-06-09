import { randomUUID } from "node:crypto";
import type { Room, RoomStore } from "./types.js";

export class InMemoryRoomStore implements RoomStore {
  private readonly rooms = new Map<string, Room>();

  create(): Room {
    const room: Room = {
      id: randomUUID(),
      createdAt: new Date(),
      participants: new Map(),
    };

    this.rooms.set(room.id, room);
    return room;
  }

  get(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  addParticipant(roomId: string, userId: string): Room | null {
    const room = this.rooms.get(roomId);

    if (!room) {
      return null;
    }

    if (room.participants.has(userId)) {
      return room;
    }

    room.participants.set(userId, {
      userId,
      joinedAt: new Date(),
    });

    return room;
  }

  hasParticipant(roomId: string, userId: string): boolean {
    const room = this.rooms.get(roomId);
    return room?.participants.has(userId) ?? false;
  }

  listParticipantIds(roomId: string): string[] {
    const room = this.rooms.get(roomId);

    if (!room) {
      return [];
    }

    return [...room.participants.keys()];
  }
}
