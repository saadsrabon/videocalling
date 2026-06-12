import type { JoinStatus, ParticipantInfo, RoomStore } from "./types.js";
import { RoomError } from "./types.js";

function toParticipantInfo(participant: {
  userId: string;
  displayName?: string;
}): ParticipantInfo {
  return {
    userId: participant.userId,
    displayName: participant.displayName?.trim() || participant.userId,
  };
}

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
      hostUserId: createdBy,
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
      hostUserId: room.createdBy,
      participantCount: this.store.countParticipants(room.id),
      maxParticipants: this.maxSfuPeers,
    };
  }

  getHostUserId(roomId: string): string | null {
    return this.store.get(roomId)?.createdBy ?? null;
  }

  isHost(roomId: string, userId: string): boolean {
    return this.getHostUserId(roomId) === userId;
  }

  join(roomId: string, userId: string, displayName?: string, options?: { ghost?: boolean }) {
    const room = this.store.get(roomId);

    if (!room) {
      throw new RoomError("room_not_found", `Room not found: ${roomId}`);
    }

    if (room.expiresAt && room.expiresAt.getTime() < Date.now()) {
      throw new RoomError("meeting_expired", `Meeting expired: ${roomId}`);
    }

    if (room.mode === "p2p") {
      const alreadyJoined = room.participants.has(userId);

      if (!alreadyJoined) {
        this.store.addParticipant(roomId, userId, displayName);
      }

      return {
        roomId,
        mode: room.mode,
        code: room.code,
        status: "admitted" as JoinStatus,
        hostUserId: room.createdBy ?? null,
        participants: this.getParticipantRoster(roomId),
        alreadyJoined,
      };
    }

    return this.joinSfuMeeting(room, userId, displayName, options);
  }

  private joinSfuMeeting(
    room: NonNullable<ReturnType<RoomStore["get"]>>,
    userId: string,
    displayName?: string,
    options?: { ghost?: boolean },
  ) {
    const roomId = room.id;
    const alreadyAdmitted = room.participants.has(userId);
    const alreadyWaiting = room.waitingParticipants.has(userId);

    if (options?.ghost) {
      this.store.addParticipant(roomId, userId, displayName ?? "Observer", {
        ghost: true,
      });

      return {
        roomId,
        mode: room.mode,
        code: room.code,
        status: "admitted" as JoinStatus,
        hostUserId: room.createdBy ?? null,
        participants: this.getParticipantRoster(roomId),
        alreadyJoined: alreadyAdmitted,
        ghost: true,
      };
    }

    if (alreadyAdmitted) {
      return {
        roomId,
        mode: room.mode,
        code: room.code,
        status: "admitted" as JoinStatus,
        hostUserId: room.createdBy ?? null,
        participants: this.getParticipantRoster(roomId),
        alreadyJoined: true,
      };
    }

    if (alreadyWaiting) {
      return {
        roomId,
        mode: room.mode,
        code: room.code,
        status: "waiting" as JoinStatus,
        hostUserId: room.createdBy ?? null,
        participants: this.getParticipantRoster(roomId),
        alreadyJoined: false,
      };
    }

    const isHost = room.createdBy === userId;

    if (isHost) {
      this.store.addParticipant(roomId, userId, displayName);

      return {
        roomId,
        mode: room.mode,
        code: room.code,
        status: "admitted" as JoinStatus,
        hostUserId: room.createdBy ?? null,
        participants: this.getParticipantRoster(roomId),
        alreadyJoined: false,
      };
    }

    const admittedCount = this.store.countParticipants(roomId);

    if (admittedCount >= this.maxSfuPeers) {
      throw new RoomError("room_full", `Room is full (max ${this.maxSfuPeers})`);
    }

    this.store.addWaitingParticipant(roomId, userId, displayName);

    return {
      roomId,
      mode: room.mode,
      code: room.code,
      status: "waiting" as JoinStatus,
      hostUserId: room.createdBy ?? null,
      participants: this.getParticipantRoster(roomId),
      alreadyJoined: false,
    };
  }

  joinMeetingByCode(
    code: string,
    userId: string,
    displayName?: string,
    options?: { ghost?: boolean },
  ) {
    const meeting = this.getMeetingByCode(code);
    return this.join(meeting.roomId, userId, displayName, options);
  }

  listActiveMeetings() {
    return this.store.listSfuMeetings().map((meeting) => ({
      ...meeting,
      createdAt: meeting.createdAt.toISOString(),
      maxParticipants: this.maxSfuPeers,
    }));
  }

  admitParticipant(roomId: string, hostUserId: string, targetUserId: string) {
    if (!this.isHost(roomId, hostUserId)) {
      throw new RoomError("not_host", "Only the meeting host can admit participants");
    }

    if (!this.store.hasWaitingParticipant(roomId, targetUserId)) {
      throw new RoomError("not_waiting", "Participant is not in the waiting room");
    }

    const admittedCount = this.store.countParticipants(roomId);

    if (admittedCount >= this.maxSfuPeers) {
      throw new RoomError("room_full", `Room is full (max ${this.maxSfuPeers})`);
    }

    const room = this.store.admitWaitingParticipant(roomId, targetUserId);

    if (!room) {
      throw new RoomError("room_not_found", `Room not found: ${roomId}`);
    }

    return {
      roomId,
      userId: targetUserId,
      participant: toParticipantInfo(
        room.participants.get(targetUserId) ?? { userId: targetUserId },
      ),
      roster: this.getParticipantRoster(roomId),
    };
  }

  denyParticipant(roomId: string, hostUserId: string, targetUserId: string) {
    if (!this.isHost(roomId, hostUserId)) {
      throw new RoomError("not_host", "Only the meeting host can deny participants");
    }

    if (!this.store.hasWaitingParticipant(roomId, targetUserId)) {
      throw new RoomError("not_waiting", "Participant is not in the waiting room");
    }

    this.store.removeWaitingParticipant(roomId, targetUserId);

    return { roomId, userId: targetUserId };
  }

  getWaitingRoster(roomId: string): ParticipantInfo[] {
    return this.store.listWaitingParticipants(roomId).map(toParticipantInfo);
  }

  getParticipantRoster(roomId: string): ParticipantInfo[] {
    return this.store
      .listParticipants(roomId)
      .filter((participant) => !participant.ghost)
      .map(toParticipantInfo);
  }

  isGhostParticipant(roomId: string, userId: string): boolean {
    return this.store.getParticipant(roomId, userId)?.ghost === true;
  }

  getDisplayName(roomId: string, userId: string): string {
    const participant =
      this.store.getParticipant(roomId, userId) ??
      this.store.getWaitingParticipant(roomId, userId);

    return participant?.displayName?.trim() || userId;
  }

  leave(roomId: string, userId: string): boolean {
    const removedParticipant = this.store.removeParticipant(roomId, userId);
    const removedWaiting = this.store.removeWaitingParticipant(roomId, userId);
    return removedParticipant || removedWaiting;
  }

  isParticipant(roomId: string, userId: string): boolean {
    return this.store.hasParticipant(roomId, userId);
  }

  canUseSignaling(roomId: string, userId: string): boolean {
    return this.isParticipant(roomId, userId);
  }

  isWaiting(roomId: string, userId: string): boolean {
    return this.store.hasWaitingParticipant(roomId, userId);
  }

  isInMeeting(roomId: string, userId: string): boolean {
    return this.isParticipant(roomId, userId) || this.isWaiting(roomId, userId);
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
