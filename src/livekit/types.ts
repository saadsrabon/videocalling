import type { JoinStatus } from "../rooms/types.js";

export type LiveKitParticipantRole = "host" | "participant" | "guest" | "waiting";

export interface LiveKitTokenRequest {
  roomName: string;
  identity: string;
  name?: string;
  role: LiveKitParticipantRole;
  metadata?: string;
  /** When false, user may connect but not publish A/V (lobby). */
  admitted: boolean;
  ghost?: boolean;
}

export interface LiveKitTokenResponse {
  serverUrl: string;
  participantToken: string;
}

export interface MeetingLiveKitContext {
  roomId: string;
  code: string;
  userId: string;
  displayName: string;
  status: JoinStatus;
  isHost: boolean;
  ghost?: boolean;
}
