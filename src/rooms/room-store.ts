import { randomBytes, randomUUID } from "node:crypto";
import type { Room, RoomStore } from "./types.js";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function generateMeetingCode(length = 8): string {
  const bytes = randomBytes(length);
  let code = "";

  for (let i = 0; i < length; i += 1) {
    code += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  }

  return code;
}

export class InMemoryRoomStore implements RoomStore {
  private readonly rooms = new Map<string, Room>();
  private readonly codeIndex = new Map<string, string>();

  create(options?: {
    mode?: Room["mode"];
    createdBy?: string;
    title?: string;
    code?: string;
  }): Room {
    const code = options?.code ?? (options?.mode === "sfu" ? this.uniqueCode() : undefined);

    const room: Room = {
      id: randomUUID(),
      createdAt: new Date(),
      participants: new Map(),
      mode: options?.mode ?? "p2p",
      code,
      createdBy: options?.createdBy,
      title: options?.title,
    };

    this.rooms.set(room.id, room);

    if (code) {
      this.codeIndex.set(code.toUpperCase(), room.id);
    }

    return room;
  }

  private uniqueCode(): string {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const code = generateMeetingCode();

      if (!this.codeIndex.has(code)) {
        return code;
      }
    }

    throw new Error("Failed to generate unique meeting code");
  }

  get(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  getByCode(code: string): Room | undefined {
    const roomId = this.codeIndex.get(code.toUpperCase());
    return roomId ? this.rooms.get(roomId) : undefined;
  }

  addParticipant(
    roomId: string,
    userId: string,
    displayName?: string,
  ): Room | null {
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
      displayName,
    });

    return room;
  }

  removeParticipant(roomId: string, userId: string): boolean {
    const room = this.rooms.get(roomId);

    if (!room) {
      return false;
    }

    return room.participants.delete(userId);
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

  countParticipants(roomId: string): number {
    const room = this.rooms.get(roomId);

    if (!room) {
      return 0;
    }

    return room.participants.size;
  }
}
