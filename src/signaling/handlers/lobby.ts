import type { SignalingContext } from "./join.js";
import { RoomError } from "../../rooms/types.js";
import {
  SIGNALING_VERSION,
  type ClientMessage,
  sendMessage,
} from "../message-types.js";

export function notifyHostOfWaitingRequest(
  ctx: Pick<SignalingContext, "roomService" | "registry">,
  roomId: string,
  userId: string,
): void {
  const hostUserId = ctx.roomService.getHostUserId(roomId);

  if (!hostUserId || hostUserId === userId) {
    return;
  }

  ctx.registry.sendToUser(
    hostUserId,
    JSON.stringify({
      type: "lobby.request",
      roomId,
      userId,
      displayName: ctx.roomService.getDisplayName(roomId, userId),
      v: SIGNALING_VERSION,
    }),
  );
}

export async function handleLobbyAdmit(
  ctx: SignalingContext,
  message: Extract<ClientMessage, { type: "lobby.admit" }>,
): Promise<void> {
  const { roomId, userId: targetUserId } = message;

  if (!ctx.roomService.isInMeeting(roomId, ctx.user.userId)) {
    sendMessage(ctx.send, {
      type: "error",
      code: "not_in_room",
      message: "Join the meeting before managing the lobby",
      v: SIGNALING_VERSION,
    });
    return;
  }

  try {
    const result = ctx.roomService.admitParticipant(
      roomId,
      ctx.user.userId,
      targetUserId,
    );

    const participantCount = ctx.roomService.listParticipantIds(roomId).length;

    if (!ctx.useLiveKit) {
      await ctx.sfuService.joinPeer(roomId, targetUserId, participantCount);
    } else if (ctx.liveKitRoomAdmin?.isConfigured) {
      try {
        await ctx.liveKitRoomAdmin.updateParticipantPermissions(
          roomId,
          targetUserId,
          true,
        );
      } catch {
        /* Participant may not be in LiveKit yet — client will fetch a fresh token. */
      }
    }

    sendMessage(ctx.send, {
      type: "lobby.admitted",
      roomId,
      userId: targetUserId,
      participant: result.participant,
      roster: result.roster,
      v: SIGNALING_VERSION,
    });

    ctx.registry.sendToUser(
      targetUserId,
      JSON.stringify({
        type: "lobby.admitted",
        roomId,
        roster: result.roster,
        hostUserId: ctx.roomService.getHostUserId(roomId),
        v: SIGNALING_VERSION,
      }),
    );

    if (!ctx.useLiveKit) {
      const otherParticipants = ctx.roomService
        .listParticipantIds(roomId)
        .filter((id) => id !== targetUserId && id !== ctx.user.userId);

      for (const participantId of otherParticipants) {
        ctx.registry.sendToUser(
          participantId,
          JSON.stringify({
            type: "peer-joined",
            userId: targetUserId,
            displayName: result.participant.displayName,
            v: SIGNALING_VERSION,
          }),
        );
      }
    }
  } catch (error) {
    if (error instanceof RoomError) {
      sendMessage(ctx.send, {
        type: "error",
        code: error.code,
        message: error.message,
        v: SIGNALING_VERSION,
      });
      return;
    }

    throw error;
  }
}

export async function handleLobbyDeny(
  ctx: SignalingContext,
  message: Extract<ClientMessage, { type: "lobby.deny" }>,
): Promise<void> {
  const { roomId, userId: targetUserId } = message;

  try {
    ctx.roomService.denyParticipant(roomId, ctx.user.userId, targetUserId);

    sendMessage(ctx.send, {
      type: "lobby.denied",
      roomId,
      userId: targetUserId,
      v: SIGNALING_VERSION,
    });

    ctx.registry.sendToUser(
      targetUserId,
      JSON.stringify({
        type: "lobby.denied",
        roomId,
        message: "The host declined your request to join",
        v: SIGNALING_VERSION,
      }),
    );
  } catch (error) {
    if (error instanceof RoomError) {
      sendMessage(ctx.send, {
        type: "error",
        code: error.code,
        message: error.message,
        v: SIGNALING_VERSION,
      });
      return;
    }

    throw error;
  }
}

export function handleLobbyList(
  ctx: SignalingContext,
  message: Extract<ClientMessage, { type: "lobby.list" }>,
): void {
  const { roomId } = message;

  if (!ctx.roomService.isHost(roomId, ctx.user.userId)) {
    sendMessage(ctx.send, {
      type: "error",
      code: "not_host",
      message: "Only the meeting host can list the waiting room",
      v: SIGNALING_VERSION,
    });
    return;
  }

  sendMessage(ctx.send, {
    type: "lobby.list",
    roomId,
    waiting: ctx.roomService.getWaitingRoster(roomId),
    v: SIGNALING_VERSION,
  });
}

export function sendLobbyWaiting(
  ctx: SignalingContext,
  roomId: string,
): void {
  sendMessage(ctx.send, {
    type: "lobby.waiting",
    roomId,
    hostUserId: ctx.roomService.getHostUserId(roomId),
    v: SIGNALING_VERSION,
  });

  notifyHostOfWaitingRequest(ctx, roomId, ctx.user.userId);
}
