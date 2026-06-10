export const SIGNALING_VERSION = 1;



export interface IceCandidatePayload {

  candidate?: string;

  sdpMid?: string | null;

  sdpMLineIndex?: number | null;

  usernameFragment?: string | null;

}



export interface DtlsParametersPayload {

  role?: "auto" | "client" | "server";

  fingerprints: Array<{ algorithm: string; value: string }>;

}



export interface RtpCapabilitiesPayload {

  codecs?: unknown[];

  headerExtensions?: unknown[];

}



export interface RtpParametersPayload {

  mid?: string;

  codecs: unknown[];

  headerExtensions?: unknown[];

  encodings?: unknown[];

  rtcp?: unknown;

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

    }

  | {

      type: "sfu.getRtpCapabilities";

      roomId: string;

      requestId: string;

      v?: number;

    }

  | {

      type: "sfu.createTransport";

      roomId: string;

      requestId: string;

      direction: "send" | "recv";

      v?: number;

    }

  | {

      type: "sfu.connectTransport";

      roomId: string;

      requestId: string;

      transportId: string;

      dtlsParameters: DtlsParametersPayload;

      v?: number;

    }

  | {

      type: "sfu.produce";

      roomId: string;

      requestId: string;

      transportId: string;

      kind: "audio" | "video";

      rtpParameters: RtpParametersPayload;

      appData?: { source?: string };

      v?: number;

    }

  | {

      type: "sfu.consume";

      roomId: string;

      requestId: string;

      producerId: string;

      rtpCapabilities: RtpCapabilitiesPayload;

      v?: number;

    }

  | {

      type: "sfu.resumeConsumer";

      roomId: string;

      requestId: string;

      consumerId: string;

      v?: number;

    }

  | {

      type: "sfu.closeProducer";

      roomId: string;

      requestId: string;

      producerId: string;

      v?: number;

    }

  | {

      type: "sfu.listProducers";

      roomId: string;

      requestId: string;

      v?: number;

    };



export type ServerMessage =

  | { type: "connected"; userId: string; v: number }

  | {

      type: "joined";

      roomId: string;

      participants: string[];

      mode?: "p2p" | "sfu";

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

  | {

      type: "sfu.rtpCapabilities";

      requestId: string;

      rtpCapabilities: RtpCapabilitiesPayload;

      v: number;

    }

  | {

      type: "sfu.transportCreated";

      requestId: string;

      transportId: string;

      iceParameters: unknown;

      iceCandidates: unknown[];

      dtlsParameters: DtlsParametersPayload;

      v: number;

    }

  | { type: "sfu.transportConnected"; requestId: string; v: number }

  | {

      type: "sfu.produced";

      requestId: string;

      producerId: string;

      v: number;

    }

  | {

      type: "sfu.consumed";

      requestId: string;

      consumerId: string;

      producerId: string;

      kind: "audio" | "video";

      rtpParameters: RtpParametersPayload;

      appData?: { source?: string };

      v: number;

    }

  | { type: "sfu.consumerResumed"; requestId: string; v: number }

  | { type: "sfu.producerClosedAck"; requestId: string; v: number }
  | {
      type: "sfu.producerList";
      requestId: string;
      producers: Array<{
        peerId: string;
        producerId: string;
        kind: "audio" | "video";
        source?: string;
      }>;
      v: number;
    }

  | {

      type: "sfu.newProducer";

      roomId: string;

      peerId: string;

      producerId: string;

      kind: "audio" | "video";

      appData?: { source?: string };

      v: number;

    }

  | {

      type: "sfu.producerClosed";

      roomId: string;

      peerId: string;

      producerId: string;

      v: number;

    }

  | { type: "sfu.peerLeft"; roomId: string; peerId: string; v: number }

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


