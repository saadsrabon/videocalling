export const SIGNALING_VERSION = 1;

export interface IceCandidatePayload {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

export type ClientMessage =
  | { type: "join"; roomId: string; v?: number }
  | { type: "offer"; to: string; sdp: string; v?: number }
  | { type: "answer"; to: string; sdp: string; v?: number }
  | {
      type: "ice-candidate";
      to: string;
      candidate: IceCandidatePayload;
      v?: number;
    }
  | {
      type: "call.invite";
      to: string;
      callId: string;
      roomId: string;
      fromName?: string;
      fromEmail?: string;
      v?: number;
    }
  | {
      type: "call.accept";
      to: string;
      callId: string;
      roomId: string;
      v?: number;
    }
  | {
      type: "call.reject";
      to: string;
      callId: string;
      roomId: string;
      v?: number;
    }
  | {
      type: "call.end";
      to: string;
      callId: string;
      roomId: string;
      v?: number;
    }
  | {
      type: "call.cancel";
      to: string;
      callId: string;
      roomId: string;
      v?: number;
    };

export type ServerMessage =
  | { type: "connected"; userId: string; v: number }
  | {
      type: "joined";
      roomId: string;
      participants: string[];
      v: number;
    }
  | { type: "peer-joined"; userId: string; v: number }
  | { type: "offer"; from: string; sdp: string; v: number }
  | { type: "answer"; from: string; sdp: string; v: number }
  | {
      type: "ice-candidate";
      from: string;
      candidate: IceCandidatePayload;
      v: number;
    }
  | {
      type: "call.invite";
      from: string;
      to: string;
      callId: string;
      roomId: string;
      fromName?: string;
      fromEmail?: string;
      v: number;
    }
  | {
      type: "call.accept";
      from: string;
      to: string;
      callId: string;
      roomId: string;
      v: number;
    }
  | {
      type: "call.reject";
      from: string;
      to: string;
      callId: string;
      roomId: string;
      v: number;
    }
  | {
      type: "call.end";
      from: string;
      to: string;
      callId: string;
      roomId: string;
      v: number;
    }
  | {
      type: "call.cancel";
      from: string;
      to: string;
      callId: string;
      roomId: string;
      v: number;
    }
  | { type: "error"; code: string; message: string; v: number };

export function parseClientMessage(raw: string): ClientMessage {
  const data: unknown = JSON.parse(raw);

  if (data === null || typeof data !== "object" || !("type" in data)) {
    throw new Error("Invalid message shape");
  }

  return data as ClientMessage;
}

export function sendMessage(
  send: (payload: string) => void,
  message: ServerMessage,
): void {
  send(JSON.stringify(message));
}
