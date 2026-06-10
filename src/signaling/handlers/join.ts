import type { AuthUser } from "../../auth/types.js";
import type { RoomService } from "../../rooms/room-service.js";
import type { SfuService } from "../../sfu/sfu-service.js";
import type { ConnectionRegistry } from "../connection-registry.js";
import {
  SIGNALING_VERSION,
  type ClientMessage,
  sendMessage,
} from "../message-types.js";

export interface SignalingContext {
  user: AuthUser;
  roomService: RoomService;
  registry: ConnectionRegistry;
  sfuService: SfuService;
  send: (payload: string) => void;
}

function assertGuestRoomAccess(user: AuthUser, roomId: string): boolean {
  const role = user.metadata?.role;

  if (role !== "guest") {
    return true;
  }

  const allowedRoomId = user.metadata?.roomId;

  return typeof allowedRoomId === "string" && allowedRoomId === roomId;
}

export async function handleJoin(
  ctx: SignalingContext,
  message: Extract<ClientMessage, { type: "join" }>,
): Promise<void> {
  const { roomId } = message;

  if (!ctx.roomService.isParticipant(roomId, ctx.user.userId)) {
    sendMessage(ctx.send, {
      type: "error",
      code: "not_in_room",
      message: "Join the room via HTTP before signaling",
      v: SIGNALING_VERSION,
    });
    return;
  }

  if (!assertGuestRoomAccess(ctx.user, roomId)) {
    sendMessage(ctx.send, {
      type: "error",
      code: "forbidden",
      message: "Guest token is not valid for this room",
      v: SIGNALING_VERSION,
    });
    return;
  }

  ctx.registry.bindRoom(ctx.user.userId, roomId);

  const roomMode = ctx.roomService.getRoomMode(roomId) ?? "p2p";
  const participantCount = ctx.roomService.listParticipantIds(roomId).length;

  if (roomMode === "sfu") {
    await ctx.sfuService.joinPeer(roomId, ctx.user.userId, participantCount);
  }

  const participants = ctx.roomService
    .listParticipantIds(roomId)
    .filter((id: string) => id !== ctx.user.userId);

  sendMessage(ctx.send, {
    type: "joined",
    roomId,
    participants,
    mode: roomMode,
    v: SIGNALING_VERSION,
  });

  for (const participantId of participants) {
    ctx.registry.sendToUser(
      participantId,
      JSON.stringify({
        type: "peer-joined",
        userId: ctx.user.userId,
        v: SIGNALING_VERSION,
      }),
    );
  }
}

export function handlePeerDisconnect(
  ctx: Pick<SignalingContext, "roomService" | "registry" | "sfuService">,
  userId: string,
): void {
  const roomId = ctx.registry.getRoomId(userId);

  if (!roomId) {
    return;
  }

  const roomMode = ctx.roomService.getRoomMode(roomId);

  if (roomMode === "sfu") {
    ctx.sfuService.removePeer(roomId, userId);
  }

  ctx.roomService.leave(roomId, userId);
}
