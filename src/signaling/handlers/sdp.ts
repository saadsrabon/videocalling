import type { SignalingContext } from "./join.js";
import {
  SIGNALING_VERSION,
  type ClientMessage,
  sendMessage,
} from "../message-types.js";

type SdpMessage = Extract<
  ClientMessage,
  { type: "offer" } | { type: "answer" }
>;

function relaySdp(ctx: SignalingContext, message: SdpMessage): void {
  const roomId = ctx.registry.getRoomId(ctx.user.userId);

  if (!roomId) {
    sendMessage(ctx.send, {
      type: "error",
      code: "not_signaled",
      message: "Send join message before SDP relay",
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

  const payload =
    message.type === "offer"
      ? JSON.stringify({
          type: "offer" as const,
          from: ctx.user.userId,
          sdp: message.sdp,
          v: SIGNALING_VERSION,
        })
      : JSON.stringify({
          type: "answer" as const,
          from: ctx.user.userId,
          sdp: message.sdp,
          v: SIGNALING_VERSION,
        });

  const delivered = ctx.registry.sendToUser(message.to, payload);

  if (!delivered) {
    sendMessage(ctx.send, {
      type: "error",
      code: "peer_unavailable",
      message: "Target peer is not connected",
      v: SIGNALING_VERSION,
    });
  }
}

export function handleOffer(
  ctx: SignalingContext,
  message: Extract<ClientMessage, { type: "offer" }>,
): void {
  relaySdp(ctx, message);
}

export function handleAnswer(
  ctx: SignalingContext,
  message: Extract<ClientMessage, { type: "answer" }>,
): void {
  relaySdp(ctx, message);
}
