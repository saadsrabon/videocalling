import type {
  Consumer,
  DtlsParameters,
  Producer,
  RtpCapabilities,
  RtpParameters,
  WebRtcTransport,
  Worker,
  WebRtcServer,
} from "mediasoup/types";
import { mediaCodecs } from "./media-codecs.js";
import {
  SfuError,
  type ProducerInfo,
  type SfuPeer,
  type SfuRoom,
  type TransportDirection,
} from "./types.js";

export interface SfuServiceOptions {
  worker: Worker;
  webRtcServer: WebRtcServer;
  maxPeersPerRoom: number;
}

export type SfuEvent =
  | {
      type: "newProducer";
      roomId: string;
      peerId: string;
      producerId: string;
      kind: "audio" | "video";
      source?: string;
    }
  | {
      type: "producerClosed";
      roomId: string;
      peerId: string;
      producerId: string;
    }
  | { type: "peerLeft"; roomId: string; peerId: string };

export type SfuEventHandler = (event: SfuEvent) => void;

export class SfuService {
  private readonly rooms = new Map<string, SfuRoom>();
  private readonly handlers = new Set<SfuEventHandler>();

  constructor(private readonly options: SfuServiceOptions) {}

  on(handler: SfuEventHandler): void {
    this.handlers.add(handler);
  }

  off(handler: SfuEventHandler): void {
    this.handlers.delete(handler);
  }

  private emit(event: SfuEvent): void {
    for (const handler of this.handlers) {
      handler(event);
    }
  }

  private getRoom(roomId: string): SfuRoom {
    const room = this.rooms.get(roomId);

    if (!room) {
      throw new SfuError("room_not_found", `SFU room not found: ${roomId}`);
    }

    return room;
  }

  private getPeer(room: SfuRoom, userId: string): SfuPeer {
    const peer = room.peers.get(userId);

    if (!peer) {
      throw new SfuError("peer_not_found", `Peer not found in SFU room: ${userId}`);
    }

    return peer;
  }

  private getTransport(
    peer: SfuPeer,
    transportId: string,
  ): WebRtcTransport {
    if (peer.sendTransport?.id === transportId) {
      return peer.sendTransport;
    }

    if (peer.recvTransport?.id === transportId) {
      return peer.recvTransport;
    }

    throw new SfuError(
      "transport_not_found",
      `Transport not found: ${transportId}`,
    );
  }

  async ensureRoom(roomId: string, participantCount: number): Promise<SfuRoom> {
    let room = this.rooms.get(roomId);

    if (!room) {
      const router = await this.options.worker.createRouter({ mediaCodecs });
      room = {
        roomId,
        router,
        peers: new Map(),
      };
      this.rooms.set(roomId, room);
    }

    if (participantCount > this.options.maxPeersPerRoom) {
      throw new SfuError(
        "room_full",
        `Room is full (max ${this.options.maxPeersPerRoom} participants)`,
      );
    }

    return room;
  }

  async joinPeer(roomId: string, userId: string, participantCount: number): Promise<void> {
    const room = await this.ensureRoom(roomId, participantCount);

    if (!room.peers.has(userId)) {
      room.peers.set(userId, {
        userId,
        producers: new Map(),
        consumers: new Map(),
      });
    }
  }

  /** Clear stale transports/producers when the same user re-joins signaling (reload/reconnect). */
  resetPeerForRejoin(roomId: string, userId: string): void {
    const room = this.rooms.get(roomId);

    if (!room) {
      return;
    }

    const peer = room.peers.get(userId);

    if (!peer) {
      return;
    }

    for (const producer of peer.producers.values()) {
      producer.close();
    }

    for (const consumer of peer.consumers.values()) {
      consumer.close();
    }

    peer.sendTransport?.close();
    peer.recvTransport?.close();
    peer.producers.clear();
    peer.consumers.clear();
    peer.sendTransport = undefined;
    peer.recvTransport = undefined;
  }

  getRtpCapabilities(roomId: string): RtpCapabilities {
    const room = this.getRoom(roomId);
    return room.router.rtpCapabilities;
  }

  listProducers(roomId: string, excludePeerId?: string): ProducerInfo[] {
    const room = this.getRoom(roomId);
    const latestByKey = new Map<string, ProducerInfo>();

    for (const [peerId, peer] of room.peers) {
      if (excludePeerId && peerId === excludePeerId) {
        continue;
      }

      for (const producer of peer.producers.values()) {
        const appData = producer.appData as { source?: string };
        const sourceKey = appData.source ?? (producer.kind === "audio" ? "mic" : "camera");
        const key = `${peerId}:${producer.kind}:${sourceKey}`;
        latestByKey.set(key, {
          producerId: producer.id,
          peerId,
          kind: producer.kind,
          source: appData.source,
        });
      }
    }

    return [...latestByKey.values()];
  }

  async createWebRtcTransport(
    roomId: string,
    userId: string,
    direction: TransportDirection,
  ): Promise<{
    id: string;
    iceParameters: WebRtcTransport["iceParameters"];
    iceCandidates: WebRtcTransport["iceCandidates"];
    dtlsParameters: WebRtcTransport["dtlsParameters"];
  }> {
    const room = this.getRoom(roomId);
    const peer = this.getPeer(room, userId);

    const transport = await room.router.createWebRtcTransport({
      webRtcServer: this.options.webRtcServer,
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      appData: { direction },
    });

    if (direction === "send") {
      peer.sendTransport?.close();
      peer.sendTransport = transport;
    } else {
      peer.recvTransport?.close();
      peer.recvTransport = transport;
    }

    return {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
    };
  }

  async connectTransport(
    roomId: string,
    userId: string,
    transportId: string,
    dtlsParameters: DtlsParameters,
  ): Promise<void> {
    const room = this.getRoom(roomId);
    const peer = this.getPeer(room, userId);
    const transport = this.getTransport(peer, transportId);
    await transport.connect({ dtlsParameters });
  }

  async restartIce(
    roomId: string,
    userId: string,
    transportId: string,
  ): Promise<{ iceParameters: WebRtcTransport["iceParameters"] }> {
    const room = this.getRoom(roomId);
    const peer = this.getPeer(room, userId);
    const transport = this.getTransport(peer, transportId);
    const iceParameters = await transport.restartIce();
    return { iceParameters };
  }

  async produce(
    roomId: string,
    userId: string,
    transportId: string,
    kind: "audio" | "video",
    rtpParameters: RtpParameters,
    appData?: { source?: string },
  ): Promise<{ producerId: string }> {
    const room = this.getRoom(roomId);
    const peer = this.getPeer(room, userId);
    const transport = this.getTransport(peer, transportId);

    if (transport.appData.direction !== "send") {
      throw new SfuError(
        "invalid_direction",
        "Cannot produce on a receive transport",
      );
    }

    const nextSource = appData?.source;
    for (const [existingId, existing] of peer.producers) {
      if (existing.kind !== kind) {
        continue;
      }

      const existingSource = (existing.appData as { source?: string }).source;

      if (existingSource === nextSource || kind === "audio") {
        existing.close();
        peer.producers.delete(existingId);
        this.emit({
          type: "producerClosed",
          roomId,
          peerId: userId,
          producerId: existingId,
        });
      }
    }

    const producer = await transport.produce({
      kind,
      rtpParameters,
      appData: appData ?? {},
    });

    peer.producers.set(producer.id, producer);

    producer.on("transportclose", () => {
      peer.producers.delete(producer.id);
      this.emit({
        type: "producerClosed",
        roomId,
        peerId: userId,
        producerId: producer.id,
      });
    });

    this.emit({
      type: "newProducer",
      roomId,
      peerId: userId,
      producerId: producer.id,
      kind,
      source: appData?.source,
    });

    return { producerId: producer.id };
  }

  async consume(
    roomId: string,
    userId: string,
    producerId: string,
    rtpCapabilities: RtpCapabilities,
  ): Promise<{
    consumerId: string;
    producerId: string;
    kind: Consumer["kind"];
    rtpParameters: RtpParameters;
    source?: string;
  }> {
    const room = this.getRoom(roomId);
    const peer = this.getPeer(room, userId);

    if (!peer.recvTransport) {
      throw new SfuError(
        "transport_not_found",
        "Receive transport must be created before consuming",
      );
    }

    if (!room.router.canConsume({ producerId, rtpCapabilities })) {
      throw new SfuError(
        "producer_not_found",
        `Cannot consume producer: ${producerId}`,
      );
    }

    const consumer = await peer.recvTransport.consume({
      producerId,
      rtpCapabilities,
      paused: true,
    });

    peer.consumers.set(consumer.id, consumer);

    consumer.on("transportclose", () => {
      peer.consumers.delete(consumer.id);
    });

    consumer.on("producerclose", () => {
      peer.consumers.delete(consumer.id);
    });

    const producer = this.findProducer(room, producerId);
    const appData = producer?.appData as { source?: string } | undefined;

    return {
      consumerId: consumer.id,
      producerId,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
      source: appData?.source,
    };
  }

  async resumeConsumer(
    roomId: string,
    userId: string,
    consumerId: string,
  ): Promise<void> {
    const room = this.getRoom(roomId);
    const peer = this.getPeer(room, userId);
    const consumer = peer.consumers.get(consumerId);

    if (!consumer) {
      throw new SfuError(
        "consumer_not_found",
        `Consumer not found: ${consumerId}`,
      );
    }

    await consumer.resume();
  }

  async closeProducer(
    roomId: string,
    userId: string,
    producerId: string,
  ): Promise<void> {
    const room = this.getRoom(roomId);
    const peer = this.getPeer(room, userId);
    const producer = peer.producers.get(producerId);

    if (!producer) {
      throw new SfuError(
        "producer_not_found",
        `Producer not found: ${producerId}`,
      );
    }

    producer.close();
    peer.producers.delete(producerId);

    this.emit({
      type: "producerClosed",
      roomId,
      peerId: userId,
      producerId,
    });
  }

  removePeer(roomId: string, userId: string): void {
    const room = this.rooms.get(roomId);

    if (!room) {
      return;
    }

    const peer = room.peers.get(userId);

    if (!peer) {
      return;
    }

    for (const producer of peer.producers.values()) {
      producer.close();
    }

    for (const consumer of peer.consumers.values()) {
      consumer.close();
    }

    peer.sendTransport?.close();
    peer.recvTransport?.close();
    room.peers.delete(userId);

    this.emit({ type: "peerLeft", roomId, peerId: userId });

    if (room.peers.size === 0) {
      room.router.close();
      this.rooms.delete(roomId);
    }
  }

  closeRoom(roomId: string): void {
    const room = this.rooms.get(roomId);

    if (!room) {
      return;
    }

    for (const peer of room.peers.values()) {
      for (const producer of peer.producers.values()) {
        producer.close();
      }

      for (const consumer of peer.consumers.values()) {
        consumer.close();
      }

      peer.sendTransport?.close();
      peer.recvTransport?.close();
    }

    room.peers.clear();
    room.router.close();
    this.rooms.delete(roomId);
  }

  private findProducer(room: SfuRoom, producerId: string): Producer | undefined {
    for (const peer of room.peers.values()) {
      const producer = peer.producers.get(producerId);

      if (producer) {
        return producer;
      }
    }

    return undefined;
  }
}
