import type { AuthUser } from "../../auth/types.js";
import type { RoomService } from "../../rooms/room-service.js";
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
  send: (payload: string) => void;
}

export function handleJoin(
  ctx: SignalingContext,
  message: Extract<ClientMessage, { type: "join" }>,
): void {
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

  ctx.registry.bindRoom(ctx.user.userId, roomId);

  const participants = ctx.roomService
    .listParticipantIds(roomId)
    .filter((id: string) => id !== ctx.user.userId);

  sendMessage(ctx.send, {
    type: "joined",
    roomId,
    participants,
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
