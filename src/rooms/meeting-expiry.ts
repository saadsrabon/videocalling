import type { FastifyBaseLogger } from "fastify";
import type { LiveKitRoomAdmin } from "../livekit/room-service-client.js";
import type { RoomService } from "./room-service.js";
import type { SfuService } from "../sfu/sfu-service.js";
import type { ConnectionRegistry } from "../signaling/connection-registry.js";
import { terminateMeetingSession } from "./meeting-terminate.js";

const DEFAULT_INTERVAL_MS = 15_000;

export function startMeetingExpiryWatcher(deps: {
  roomService: RoomService;
  sfuService: SfuService;
  registry: ConnectionRegistry;
  liveKitRoomAdmin?: LiveKitRoomAdmin;
  log: FastifyBaseLogger;
  intervalMs?: number;
}): () => void {
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;

  const timer = setInterval(() => {
    for (const meeting of deps.roomService.listExpiredMeetings()) {
      deps.log.info(
        { roomId: meeting.roomId, code: meeting.code },
        "Meeting duration expired — terminating",
      );

      terminateMeetingSession({
        roomId: meeting.roomId,
        roomService: deps.roomService,
        sfuService: deps.sfuService,
        registry: deps.registry,
        liveKitRoomAdmin: deps.liveKitRoomAdmin,
        reason: "expired",
        message: "This meeting has reached its time limit and ended.",
      });
    }
  }, intervalMs);

  return () => {
    clearInterval(timer);
  };
}
