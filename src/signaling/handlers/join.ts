import type { AuthUser } from "../../auth/types.js";
import type { LiveKitRoomAdmin } from "../../livekit/room-service-client.js";
import type { RoomService } from "../../rooms/room-service.js";
import type { SfuService } from "../../sfu/sfu-service.js";
import type { ConnectionRegistry } from "../connection-registry.js";
import { sendLobbyWaiting } from "./lobby.js";
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
  liveKitRoomAdmin?: LiveKitRoomAdmin;
  useLiveKit?: boolean;
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

  if (!ctx.roomService.isInMeeting(roomId, ctx.user.userId)) {
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

  if (roomMode === "sfu" && ctx.roomService.isWaiting(roomId, ctx.user.userId)) {
    sendLobbyWaiting(ctx, roomId);
    return;
  }

  const participantCount = ctx.roomService.listParticipantIds(roomId).length;

  if (roomMode === "sfu" && ctx.roomService.isGhostParticipant(roomId, ctx.user.userId)) {
    ctx.sfuService.resetPeerForRejoin(roomId, ctx.user.userId);
    await ctx.sfuService.joinPeer(roomId, ctx.user.userId, participantCount);
  } else if (roomMode === "sfu") {
    ctx.sfuService.resetPeerForRejoin(roomId, ctx.user.userId);
    await ctx.sfuService.joinPeer(roomId, ctx.user.userId, participantCount);
  }
  const roster = ctx.roomService.getParticipantRoster(roomId);
  const participants = roster
    .map((participant) => participant.userId)
    .filter((id) => id !== ctx.user.userId);

  const isGhost = ctx.roomService.isGhostParticipant(roomId, ctx.user.userId);

  sendMessage(ctx.send, {
    type: "joined",
    roomId,
    participants,
    roster,
    hostUserId: ctx.roomService.getHostUserId(roomId),
    mode: roomMode,
    ghost: isGhost,
    v: SIGNALING_VERSION,
  });

  if (isGhost) {
    return;
  }

  for (const participant of roster) {
    if (participant.userId === ctx.user.userId) {
      continue;
    }

    ctx.registry.sendToUser(
      participant.userId,
      JSON.stringify({
        type: "peer-joined",
        userId: ctx.user.userId,
        displayName: ctx.roomService.getDisplayName(roomId, ctx.user.userId),
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
  const wasAdmitted = ctx.roomService.isParticipant(roomId, userId);

  if (roomMode === "sfu" && wasAdmitted) {
    ctx.sfuService.removePeer(roomId, userId);
  }

  ctx.roomService.leave(roomId, userId);
}
