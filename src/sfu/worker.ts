import * as mediasoup from "mediasoup";
import type { WebRtcServer, Worker } from "mediasoup/types";

export interface MediasoupRuntime {
  worker: Worker;
  webRtcServer: WebRtcServer;
}

export interface MediasoupWorkerOptions {
  announcedIp: string;
  listenPort: number;
}

export async function createMediasoupRuntime(
  options: MediasoupWorkerOptions,
): Promise<MediasoupRuntime> {
  const worker = await mediasoup.createWorker({
    logLevel: "warn",
    rtcMinPort: 40000,
    rtcMaxPort: 40100,
  });

  worker.on("died", () => {
    console.error("mediasoup Worker died — exiting");
    process.exit(1);
  });

  const webRtcServer = await worker.createWebRtcServer({
    listenInfos: [
      {
        protocol: "udp",
        ip: "0.0.0.0",
        announcedAddress: options.announcedIp,
        port: options.listenPort,
      },
      {
        protocol: "tcp",
        ip: "0.0.0.0",
        announcedAddress: options.announcedIp,
        port: options.listenPort,
      },
    ],
  });

  return { worker, webRtcServer };
}
