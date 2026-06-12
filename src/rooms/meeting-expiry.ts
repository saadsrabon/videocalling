import type { FastifyBaseLogger } from "fastify";
import type { RoomService } from "./room-service.js";
import type { SfuService } from "../sfu/sfu-service.js";
import type { ConnectionRegistry } from "../signaling/connection-registry.js";
import { SIGNALING_VERSION, sendMessage } from "../signaling/message-types.js";

const DEFAULT_INTERVAL_MS = 15_000;

export function startMeetingExpiryWatcher(deps: {
  roomService: RoomService;
  sfuService: SfuService;
  registry: ConnectionRegistry;
  log: FastifyBaseLogger;
  intervalMs?: number;
}): () => void {
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;

  const timer = setInterval(() => {
    for (const meeting of deps.roomService.listExpiredMeetings()) {
      const connectedUserIds = deps.registry.listUserIdsInRoom(meeting.roomId);

      deps.log.info(
        { roomId: meeting.roomId, code: meeting.code },
        "Meeting duration expired — terminating",
      );

      sendMessage(
        (payload) => {
          deps.registry.broadcastToRoom(meeting.roomId, payload);
        },
        {
          type: "meeting.ended",
          roomId: meeting.roomId,
          reason: "expired",
          message: "This meeting has reached its time limit and ended.",
          v: SIGNALING_VERSION,
        },
      );

      deps.sfuService.closeRoom(meeting.roomId);
      deps.roomService.terminateMeeting(meeting.roomId);

      for (const userId of connectedUserIds) {
        const socket = deps.registry.getSocket(userId);

        if (socket && socket.readyState === socket.OPEN) {
          socket.close(4410, "Meeting expired");
        }
      }
    }
  }, intervalMs);

  return () => {
    clearInterval(timer);
  };
}
