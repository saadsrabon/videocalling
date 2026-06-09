import type { SignalingContext } from "./join.js";
import {
  SIGNALING_VERSION,
  type ClientMessage,
  sendMessage,
} from "../message-types.js";

export function handleIceCandidate(
  ctx: SignalingContext,
  message: Extract<ClientMessage, { type: "ice-candidate" }>,
): void {
  const roomId = ctx.registry.getRoomId(ctx.user.userId);

  if (!roomId) {
    sendMessage(ctx.send, {
      type: "error",
      code: "not_signaled",
      message: "Send join message before ICE relay",
      v: SIGNALING_VERSION,
    });
    return;
  }

  if (!ctx.roomService.isParticipant(roomId, message.to)) {
    sendMessage(ctx.send, {
      type: "error",
      code: "peer_not_in_room",
      message: "Target user is not in this room",
      v: SIGNALING_VERSION,
    });
    return;
  }

  const delivered = ctx.registry.sendToUser(
    message.to,
    JSON.stringify({
      type: "ice-candidate",
      from: ctx.user.userId,
      candidate: message.candidate,
      v: SIGNALING_VERSION,
    }),
  );

  if (!delivered) {
    sendMessage(ctx.send, {
      type: "error",
      code: "peer_unavailable",
      message: "Target peer is not connected",
      v: SIGNALING_VERSION,
    });
  }
}
