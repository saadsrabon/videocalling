import { MeetingClient } from "/packages/client-sdk/dist/index.js";

const serverUrlInput = document.getElementById("serverUrl");
const hostTokenInput = document.getElementById("hostToken");
const joinTokenInput = document.getElementById("joinToken");
const meetingCodeInput = document.getElementById("meetingCode");
const joinUrlInput = document.getElementById("joinUrl");
const guestNameInput = document.getElementById("guestName");
const localVideo = document.getElementById("localVideo");
const remoteGrid = document.getElementById("remoteGrid");
const logEl = document.getElementById("log");

const hostTokenBtn = document.getElementById("hostTokenBtn");
const createMeetingBtn = document.getElementById("createMeetingBtn");
const hostJoinBtn = document.getElementById("hostJoinBtn");
const guestJoinBtn = document.getElementById("guestJoinBtn");
const tokenJoinBtn = document.getElementById("tokenJoinBtn");
const leaveBtn = document.getElementById("leaveBtn");
const muteMicBtn = document.getElementById("muteMicBtn");
const cameraOffBtn = document.getElementById("cameraOffBtn");
const screenShareBtn = document.getElementById("screenShareBtn");

/** @type {MeetingClient | null} */
let client = null;

/** @type {Map<string, HTMLVideoElement>} */
const remoteVideos = new Map();

function log(message) {
  logEl.textContent += `${new Date().toLocaleTimeString()} ${message}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function serverUrl() {
  const trimmed = serverUrlInput.value.trim();
  if (!trimmed) {
    throw new Error("Server URL is required");
  }
  return trimmed.replace(/\/$/, "");
}

async function fetchDevToken(userId) {
  const response = await fetch(
    `${serverUrl()}/v1/dev/token?userId=${encodeURIComponent(userId)}`,
  );
  if (!response.ok) {
    throw new Error(`Dev token failed (${response.status})`);
  }
  const data = await response.json();
  return data.token;
}

function setControlsInMeeting(active) {
  leaveBtn.disabled = !active;
  muteMicBtn.disabled = !active;
  cameraOffBtn.disabled = !active;
  screenShareBtn.disabled = !active;
  createMeetingBtn.disabled = active;
  hostJoinBtn.disabled = active;
  guestJoinBtn.disabled = active;
  tokenJoinBtn.disabled = active;
}

function remoteKey(peerId, source) {
  return `${peerId}:${source}`;
}

function ensureRemoteTile(peerId, source) {
  const key = remoteKey(peerId, source);
  let video = remoteVideos.get(key);
  if (video) {
    return video;
  }

  const tile = document.createElement("div");
  tile.className = "tile";
  tile.dataset.remoteKey = key;

  const title = document.createElement("h3");
  title.textContent = `${peerId} (${source})`;

  video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;

  tile.append(title, video);
  remoteGrid.append(tile);
  remoteVideos.set(key, video);
  return video;
}

function removeRemoteTile(peerId, source) {
  const key = remoteKey(peerId, source ?? "camera");
  const video = remoteVideos.get(key);
  if (!video) {
    return;
  }

  const tile = video.closest(".tile");
  tile?.remove();
  remoteVideos.delete(key);
}

function wireClientEvents(meetingClient) {
  meetingClient.on((event) => {
    switch (event.type) {
      case "connected":
        log(`Connected as ${event.userId}`);
        break;
      case "joined":
        log(
          `Joined room ${event.roomId} — ${event.participants.length} other participant(s)`,
        );
        break;
      case "peer-joined":
        log(`Peer joined: ${event.userId}`);
        break;
      case "peer-left":
        log(`Peer left: ${event.userId}`);
        break;
      case "track-added": {
        log(`Track added: ${event.peerId} ${event.kind} (${event.source})`);
        const video = ensureRemoteTile(event.peerId, event.source);
        video.srcObject = event.stream;
        break;
      }
      case "track-removed":
        log(`Track removed: ${event.peerId} ${event.producerId}`);
        removeRemoteTile(event.peerId, event.source);
        break;
      case "screen-share-started":
        log("Screen share started");
        break;
      case "screen-share-stopped":
        log("Screen share stopped");
        removeRemoteTile(meetingClient.userId, "screen");
        break;
      case "error":
        log(`Error: ${event.message}`);
        break;
      default:
        break;
    }
  });
}

async function joinMeeting(token, code, displayName) {
  if (client) {
    await client.leave();
    client = null;
  }

  remoteGrid.replaceChildren();
  remoteVideos.clear();

  log(`Joining meeting ${code}${displayName ? ` as ${displayName}` : ""}…`);

  client = await MeetingClient.join({
    serverUrl: serverUrl(),
    token,
    code,
    displayName,
  });

  wireClientEvents(client);

  const stream = client.localMediaStream;
  if (stream) {
    localVideo.srcObject = stream;
  }

  setControlsInMeeting(true);
  log("In meeting — open more tabs with different tokens to test SFU.");
}

hostTokenBtn.addEventListener("click", async () => {
  try {
    hostTokenInput.value = await fetchDevToken("host");
    log("Host token loaded");
  } catch (error) {
    log(error instanceof Error ? error.message : String(error));
  }
});

createMeetingBtn.addEventListener("click", async () => {
  try {
    const token = hostTokenInput.value.trim() || joinTokenInput.value.trim();
    if (!token) {
      throw new Error("Host token required — click Get token (host)");
    }

    const meeting = await MeetingClient.createMeeting(
      serverUrl(),
      token,
      "Local SFU test",
    );

    meetingCodeInput.value = meeting.code;
    joinUrlInput.value = meeting.joinUrl;
    hostTokenInput.value = token;
    log(`Meeting created: ${meeting.code} (max ${meeting.maxParticipants})`);
    log(`Join URL: ${meeting.joinUrl}`);
  } catch (error) {
    log(error instanceof Error ? error.message : String(error));
  }
});

hostJoinBtn.addEventListener("click", async () => {
  try {
    const token = hostTokenInput.value.trim();
    const code = meetingCodeInput.value.trim();
    if (!token || !code) {
      throw new Error("Host token and meeting code required");
    }
    await joinMeeting(token, code);
  } catch (error) {
    log(error instanceof Error ? error.message : String(error));
  }
});

guestJoinBtn.addEventListener("click", async () => {
  try {
    const code = meetingCodeInput.value.trim();
    const name = guestNameInput.value.trim() || "Guest";
    if (!code) {
      throw new Error("Meeting code required");
    }

    const guest = await MeetingClient.fetchGuestToken(serverUrl(), code, name);
    joinTokenInput.value = guest.token;
    await joinMeeting(guest.token, code, name);
  } catch (error) {
    log(error instanceof Error ? error.message : String(error));
  }
});

tokenJoinBtn.addEventListener("click", async () => {
  try {
    const token = joinTokenInput.value.trim();
    const code = meetingCodeInput.value.trim();
    if (!token || !code) {
      throw new Error("Token and meeting code required");
    }
    await joinMeeting(token, code);
  } catch (error) {
    log(error instanceof Error ? error.message : String(error));
  }
});

for (const button of document.querySelectorAll("[data-user]")) {
  button.addEventListener("click", async () => {
    const userId = button.getAttribute("data-user");
    try {
      joinTokenInput.value = await fetchDevToken(userId);
      log(`Token loaded for ${userId}`);
    } catch (error) {
      log(error instanceof Error ? error.message : String(error));
    }
  });
}

leaveBtn.addEventListener("click", async () => {
  if (client) {
    await client.leave();
    client = null;
  }
  localVideo.srcObject = null;
  remoteGrid.replaceChildren();
  remoteVideos.clear();
  setControlsInMeeting(false);
  log("Left meeting");
});

let micMuted = false;
muteMicBtn.addEventListener("click", () => {
  if (!client) {
    return;
  }
  micMuted = !micMuted;
  client.setMicMuted(micMuted);
  muteMicBtn.textContent = micMuted ? "Unmute mic" : "Mute mic";
});

let cameraOff = false;
cameraOffBtn.addEventListener("click", () => {
  if (!client) {
    return;
  }
  cameraOff = !cameraOff;
  client.setCameraOff(cameraOff);
  cameraOffBtn.textContent = cameraOff ? "Camera on" : "Camera off";
});

screenShareBtn.addEventListener("click", async () => {
  if (!client) {
    return;
  }
  try {
    if (client.isScreenSharing()) {
      await client.stopScreenShare();
      screenShareBtn.textContent = "Share screen";
    } else {
      await client.startScreenShare();
      screenShareBtn.textContent = "Stop screen share";
    }
  } catch (error) {
    log(error instanceof Error ? error.message : String(error));
  }
});

const params = new URLSearchParams(window.location.search);
if (params.get("code")) {
  meetingCodeInput.value = params.get("code");
}
if (params.get("server")) {
  serverUrlInput.value = params.get("server");
}

log("Ready — start Docker backend, then create or join a meeting.");
