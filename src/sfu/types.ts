import type {
  Consumer,
  Producer,
  Router,
  WebRtcTransport,
} from "mediasoup/types";

export type TransportDirection = "send" | "recv";

export interface SfuPeer {
  userId: string;
  sendTransport?: WebRtcTransport;
  recvTransport?: WebRtcTransport;
  producers: Map<string, Producer>;
  consumers: Map<string, Consumer>;
}

export interface SfuRoom {
  roomId: string;
  router: Router;
  peers: Map<string, SfuPeer>;
}

export type SfuErrorCode =
  | "room_not_found"
  | "peer_not_found"
  | "transport_not_found"
  | "producer_not_found"
  | "consumer_not_found"
  | "room_full"
  | "invalid_direction";

export class SfuError extends Error {
  constructor(
    readonly code: SfuErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SfuError";
  }
}

export interface ProducerInfo {
  producerId: string;
  peerId: string;
  kind: "audio" | "video";
  source?: string;
}
