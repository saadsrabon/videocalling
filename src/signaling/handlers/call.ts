import type { SignalingContext } from "./join.js";
import {
  SIGNALING_VERSION,
  type ClientMessage,
  sendMessage,
} from "../message-types.js";

type CallClientMessage = Extract<
  ClientMessage,
  | { type: "call.invite" }
  | { type: "call.accept" }
  | { type: "call.reject" }
  | { type: "call.end" }
  | { type: "call.cancel" }
>;

function relayCallEvent(
  ctx: SignalingContext,
  message: CallClientMessage,
  serverType: CallClientMessage["type"],
): void {
  if (message.to === ctx.user.userId) {
    sendMessage(ctx.send, {
      type: "error",
      code: "invalid_target",
      message: "Cannot send call signaling to yourself",
      v: SIGNALING_VERSION,
    });
    return;
  }

  const payload = JSON.stringify({
    type: serverType,
    from: ctx.user.userId,
    to: message.to,
    callId: message.callId,
    roomId: message.roomId,
    fromName: "fromName" in message ? message.fromName : undefined,
    fromEmail: "fromEmail" in message ? message.fromEmail : undefined,
    v: SIGNALING_VERSION,
  });

  const delivered = ctx.registry.sendToUser(message.to, payload);

  if (!delivered) {
    sendMessage(ctx.send, {
      type: "error",
      code: "peer_unavailable",
      message: "Staff member is not online",
      v: SIGNALING_VERSION,
    });
  }
}

export function handleCallInvite(
  ctx: SignalingContext,
  message: Extract<ClientMessage, { type: "call.invite" }>,
): void {
  relayCallEvent(ctx, message, "call.invite");
}

export function handleCallAccept(
  ctx: SignalingContext,
  message: Extract<ClientMessage, { type: "call.accept" }>,
): void {
  relayCallEvent(ctx, message, "call.accept");
}

export function handleCallReject(
  ctx: SignalingContext,
  message: Extract<ClientMessage, { type: "call.reject" }>,
): void {
  relayCallEvent(ctx, message, "call.reject");
}

export function handleCallEnd(
  ctx: SignalingContext,
  message: Extract<ClientMessage, { type: "call.end" }>,
): void {
  relayCallEvent(ctx, message, "call.end");
}

export function handleCallCancel(
  ctx: SignalingContext,
  message: Extract<ClientMessage, { type: "call.cancel" }>,
): void {
  relayCallEvent(ctx, message, "call.cancel");
}
