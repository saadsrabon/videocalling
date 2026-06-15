import type { AuthUser } from "../../auth/types.js";
import type { RoomService } from "../../rooms/room-service.js";
import type { SfuEvent, SfuService } from "../../sfu/sfu-service.js";
import type { DtlsParameters, RtpCapabilities, RtpParameters } from "mediasoup/types";
import { SfuError } from "../../sfu/types.js";
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

  if (typeof allowedRoomId !== "string" || allowedRoomId !== roomId) {
    return false;
  }

  return true;
}

function assertInRoom(ctx: SignalingContext, roomId: string): boolean {
  if (!ctx.roomService.canUseSignaling(roomId, ctx.user.userId)) {
    sendMessage(ctx.send, {
      type: "error",
      code: "not_in_room",
      message: "Join the room via HTTP before signaling",
      v: SIGNALING_VERSION,
    });
    return false;
  }

  if (!assertGuestRoomAccess(ctx.user, roomId)) {
    sendMessage(ctx.send, {
      type: "error",
      code: "forbidden",
      message: "Guest token is not valid for this room",
      v: SIGNALING_VERSION,
    });
    return false;
  }

  return true;
}

function sendSfuError(
  ctx: SignalingContext,
  requestId: string | undefined,
  code: string,
  message: string,
): void {
  sendMessage(ctx.send, {
    type: "error",
    code,
    message: requestId ? `${requestId}: ${message}` : message,
    v: SIGNALING_VERSION,
  });
}

export async function handleSfuMessage(
  ctx: SignalingContext,
  message: ClientMessage,
): Promise<void> {
  if (!message.type.startsWith("sfu.")) {
    return;
  }

  const roomId = "roomId" in message ? message.roomId : undefined;
  const requestId = "requestId" in message ? message.requestId : undefined;

  if (!roomId || !requestId) {
    sendSfuError(ctx, requestId, "invalid_message", "Missing roomId or requestId");
    return;
  }

  if (!assertInRoom(ctx, roomId)) {
    return;
  }

  const roomMode = ctx.roomService.getRoomMode(roomId);

  if (roomMode !== "sfu") {
    sendSfuError(ctx, requestId, "not_sfu_room", "Room is not an SFU meeting");
    return;
  }

  try {
    switch (message.type) {
      case "sfu.getRtpCapabilities": {
        const rtpCapabilities = ctx.sfuService.getRtpCapabilities(roomId);
        sendMessage(ctx.send, {
          type: "sfu.rtpCapabilities",
          requestId,
          rtpCapabilities,
          v: SIGNALING_VERSION,
        });
        break;
      }

      case "sfu.createTransport": {
        if (
          message.direction === "send" &&
          ctx.roomService.isGhostParticipant(roomId, ctx.user.userId)
        ) {
          sendSfuError(
            ctx,
            requestId,
            "ghost_readonly",
            "Ghost observers cannot create send transport",
          );
          break;
        }

        const transport = await ctx.sfuService.createWebRtcTransport(
          roomId,
          ctx.user.userId,
          message.direction,
        );
        sendMessage(ctx.send, {
          type: "sfu.transportCreated",
          requestId,
          transportId: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters,
          v: SIGNALING_VERSION,
        });
        break;
      }

      case "sfu.connectTransport": {
        await ctx.sfuService.connectTransport(
          roomId,
          ctx.user.userId,
          message.transportId,
          message.dtlsParameters as DtlsParameters,
        );
        sendMessage(ctx.send, {
          type: "sfu.transportConnected",
          requestId,
          v: SIGNALING_VERSION,
        });
        break;
      }

      case "sfu.produce": {
        if (ctx.roomService.isGhostParticipant(roomId, ctx.user.userId)) {
          sendSfuError(
            ctx,
            requestId,
            "ghost_readonly",
            "Ghost observers cannot publish media",
          );
          break;
        }

        const result = await ctx.sfuService.produce(
          roomId,
          ctx.user.userId,
          message.transportId,
          message.kind,
          message.rtpParameters as RtpParameters,
          message.appData,
        );
        sendMessage(ctx.send, {
          type: "sfu.produced",
          requestId,
          producerId: result.producerId,
          v: SIGNALING_VERSION,
        });
        break;
      }

      case "sfu.consume": {
        const result = await ctx.sfuService.consume(
          roomId,
          ctx.user.userId,
          message.producerId,
          message.rtpCapabilities as RtpCapabilities,
        );
        sendMessage(ctx.send, {
          type: "sfu.consumed",
          requestId,
          consumerId: result.consumerId,
          producerId: result.producerId,
          kind: result.kind,
          rtpParameters: result.rtpParameters,
          appData: result.source ? { source: result.source } : undefined,
          v: SIGNALING_VERSION,
        });
        break;
      }

      case "sfu.resumeConsumer": {
        await ctx.sfuService.resumeConsumer(
          roomId,
          ctx.user.userId,
          message.consumerId,
        );
        sendMessage(ctx.send, {
          type: "sfu.consumerResumed",
          requestId,
          v: SIGNALING_VERSION,
        });
        break;
      }

      case "sfu.closeProducer": {
        await ctx.sfuService.closeProducer(
          roomId,
          ctx.user.userId,
          message.producerId,
        );
        sendMessage(ctx.send, {
          type: "sfu.producerClosedAck",
          requestId,
          v: SIGNALING_VERSION,
        });
        break;
      }

      case "sfu.listProducers": {
        const producers = ctx.sfuService
          .listProducers(roomId, ctx.user.userId)
          .map((producer) => ({
            peerId: producer.peerId,
            producerId: producer.producerId,
            kind: producer.kind,
            source: producer.source,
          }));
        sendMessage(ctx.send, {
          type: "sfu.producerList",
          requestId,
          producers,
          v: SIGNALING_VERSION,
        });
        break;
      }

      case "sfu.restartIce": {
        const result = await ctx.sfuService.restartIce(
          roomId,
          ctx.user.userId,
          message.transportId,
        );
        sendMessage(ctx.send, {
          type: "sfu.iceRestarted",
          requestId,
          iceParameters: result.iceParameters,
          v: SIGNALING_VERSION,
        });
        break;
      }

      default:
        sendSfuError(ctx, requestId, "unknown_type", "Unsupported SFU message");
    }
  } catch (error) {
    if (error instanceof SfuError) {
      sendSfuError(ctx, requestId, error.code, error.message);
      return;
    }

    throw error;
  }
}

export function broadcastSfuEvent(
  ctx: SignalingContext,
  roomId: string,
  event: SfuEvent,
): void {
  const participants = ctx.roomService.listParticipantIds(roomId);

  for (const participantId of participants) {
    if (event.type === "newProducer") {
      if (participantId === event.peerId) {
        continue;
      }

      ctx.registry.sendToUser(
        participantId,
        JSON.stringify({
          type: "sfu.newProducer",
          roomId,
          peerId: event.peerId,
          producerId: event.producerId,
          kind: event.kind,
          appData: event.source ? { source: event.source } : undefined,
          v: SIGNALING_VERSION,
        }),
      );
    } else if (event.type === "producerClosed") {
      ctx.registry.sendToUser(
        participantId,
        JSON.stringify({
          type: "sfu.producerClosed",
          roomId,
          peerId: event.peerId,
          producerId: event.producerId,
          v: SIGNALING_VERSION,
        }),
      );
    } else if (event.type === "peerLeft") {
      ctx.registry.sendToUser(
        participantId,
        JSON.stringify({
          type: "sfu.peerLeft",
          roomId,
          peerId: event.peerId,
          v: SIGNALING_VERSION,
        }),
      );
    }
  }
}
