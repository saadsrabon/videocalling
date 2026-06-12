import { randomUUID } from "node:crypto";
import type { SignalingContext } from "./join.js";
import {
  SIGNALING_VERSION,
  type ClientMessage,
  sendMessage,
} from "../message-types.js";

const MAX_CHAT_LENGTH = 500;
const chatRateLimit = new Map<string, { count: number; resetAt: number }>();
const CHAT_RATE_LIMIT = 30;
const CHAT_RATE_WINDOW_MS = 60_000;

function checkChatRateLimit(userId: string): boolean {
  const now = Date.now();
  const entry = chatRateLimit.get(userId);

  if (!entry || entry.resetAt < now) {
    chatRateLimit.set(userId, { count: 1, resetAt: now + CHAT_RATE_WINDOW_MS });
    return true;
  }

  if (entry.count >= CHAT_RATE_LIMIT) {
    return false;
  }

  entry.count += 1;
  return true;
}

export function handleMeetingChatSend(
  ctx: SignalingContext,
  message: Extract<ClientMessage, { type: "meeting.chat.send" }>,
): void {
  const { roomId, text } = message;
  const trimmed = text.trim();

  if (!trimmed || trimmed.length > MAX_CHAT_LENGTH) {
    sendMessage(ctx.send, {
      type: "error",
      code: "invalid_chat",
      message: `Chat message must be 1-${MAX_CHAT_LENGTH} characters`,
      v: SIGNALING_VERSION,
    });
    return;
  }

  if (!ctx.roomService.isParticipant(roomId, ctx.user.userId)) {
    sendMessage(ctx.send, {
      type: "error",
      code: "not_admitted",
      message: "Only admitted participants can send chat messages",
      v: SIGNALING_VERSION,
    });
    return;
  }

  if (!checkChatRateLimit(ctx.user.userId)) {
    sendMessage(ctx.send, {
      type: "error",
      code: "rate_limited",
      message: "Too many chat messages",
      v: SIGNALING_VERSION,
    });
    return;
  }

  const payload = JSON.stringify({
    type: "meeting.chat",
    roomId,
    id: randomUUID(),
    from: ctx.user.userId,
    displayName: ctx.roomService.getDisplayName(roomId, ctx.user.userId),
    text: trimmed,
    sentAt: new Date().toISOString(),
    v: SIGNALING_VERSION,
  });

  for (const participantId of ctx.roomService.listParticipantIds(roomId)) {
    ctx.registry.sendToUser(participantId, payload);
  }
}
