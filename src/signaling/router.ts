import type { SignalingContext } from "./handlers/join.js";
import {
  handleCallAccept,
  handleCallCancel,
  handleCallEnd,
  handleCallInvite,
  handleCallReject,
} from "./handlers/call.js";
import { handleIceCandidate } from "./handlers/ice-candidate.js";
import { handleJoin } from "./handlers/join.js";
import { handleAnswer, handleOffer } from "./handlers/sdp.js";
import { handleSfuMessage } from "./handlers/sfu.js";
import {
  SIGNALING_VERSION,
  parseClientMessage,
  sendMessage,
} from "./message-types.js";

export function routeSignalingMessage(
  ctx: SignalingContext,
  raw: string,
): void {
  void (async () => {
    try {
      const message = parseClientMessage(raw);

      if (message.type.startsWith("sfu.")) {
        await handleSfuMessage(ctx, message);
        return;
      }

      switch (message.type) {
        case "join":
          await handleJoin(ctx, message);
          break;
        case "offer":
          handleOffer(ctx, message);
          break;
        case "answer":
          handleAnswer(ctx, message);
          break;
        case "ice-candidate":
          handleIceCandidate(ctx, message);
          break;
        case "call.invite":
          handleCallInvite(ctx, message);
          break;
        case "call.accept":
          handleCallAccept(ctx, message);
          break;
        case "call.reject":
          handleCallReject(ctx, message);
          break;
        case "call.end":
          handleCallEnd(ctx, message);
          break;
        case "call.cancel":
          handleCallCancel(ctx, message);
          break;
        default:
          sendMessage(ctx.send, {
            type: "error",
            code: "unknown_type",
            message: "Unsupported message type",
            v: SIGNALING_VERSION,
          });
      }
    } catch {
      sendMessage(ctx.send, {
        type: "error",
        code: "invalid_message",
        message: "Message must be valid JSON signaling payload",
        v: SIGNALING_VERSION,
      });
    }
  })();
}
