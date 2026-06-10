import type { RoomStore } from "./types.js";
import { RoomError } from "./types.js";

export class RoomService {
  constructor(
    private readonly store: RoomStore,
    private readonly maxSfuPeers: number,
  ) {}

  create() {
    const room = this.store.create({ mode: "p2p" });

    return {
      roomId: room.id,
      createdAt: room.createdAt.toISOString(),
    };
  }

  createMeeting(createdBy: string, title?: string) {
    const room = this.store.create({
      mode: "sfu",
      createdBy,
      title,
    });

    if (!room.code) {
      throw new Error("Meeting room must have a join code");
    }

    return {
      roomId: room.id,
      code: room.code,
      createdAt: room.createdAt.toISOString(),
      title: room.title,
    };
  }

  getMeetingByCode(code: string) {
    const room = this.store.getByCode(code);

    if (!room || room.mode !== "sfu") {
      throw new RoomError("meeting_not_found", `Meeting not found: ${code}`);
    }

    if (room.expiresAt && room.expiresAt.getTime() < Date.now()) {
      throw new RoomError("meeting_expired", `Meeting expired: ${code}`);
    }

    return {
      roomId: room.id,
      code: room.code!,
      title: room.title,
      participantCount: this.store.countParticipants(room.id),
      maxParticipants: this.maxSfuPeers,
    };
  }

  join(roomId: string, userId: string, displayName?: string) {
    const room = this.store.get(roomId);

    if (!room) {
      throw new RoomError("room_not_found", `Room not found: ${roomId}`);
    }

    if (room.expiresAt && room.expiresAt.getTime() < Date.now()) {
      throw new RoomError("meeting_expired", `Meeting expired: ${roomId}`);
    }

    const alreadyJoined = room.participants.has(userId);

    if (!alreadyJoined && room.mode === "sfu") {
      const count = this.store.countParticipants(roomId);

      if (count >= this.maxSfuPeers) {
        throw new RoomError("room_full", `Room is full (max ${this.maxSfuPeers})`);
      }
    }

    this.store.addParticipant(roomId, userId, displayName);

    return {
      roomId,
      mode: room.mode,
      code: room.code,
      participants: this.store.listParticipantIds(roomId),
      alreadyJoined,
    };
  }

  joinMeetingByCode(code: string, userId: string, displayName?: string) {
    const meeting = this.getMeetingByCode(code);
    return this.join(meeting.roomId, userId, displayName);
  }

  leave(roomId: string, userId: string): boolean {
    return this.store.removeParticipant(roomId, userId);
  }

  isParticipant(roomId: string, userId: string): boolean {
    return this.store.hasParticipant(roomId, userId);
  }

  listParticipantIds(roomId: string): string[] {
    return this.store.listParticipantIds(roomId);
  }

  getRoomMode(roomId: string): "p2p" | "sfu" | null {
    const room = this.store.get(roomId);
    return room?.mode ?? null;
  }

  getRoomIdByCode(code: string): string | null {
    const room = this.store.getByCode(code);
    return room?.id ?? null;
  }
}
