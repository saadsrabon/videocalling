import { VideoClient } from "/packages/client-sdk/dist/index.js";

const serverUrlInput = document.getElementById("serverUrl");
const tokenInput = document.getElementById("token");
const roomIdInput = document.getElementById("roomId");
const shareLinkInput = document.getElementById("shareLink");
const tokenUserABtn = document.getElementById("tokenUserABtn");
const tokenUserBBtn = document.getElementById("tokenUserBBtn");
const tokenUserCBtn = document.getElementById("tokenUserCBtn");
const useWifiServerBtn = document.getElementById("useWifiServerBtn");
const connectBtn = document.getElementById("connectBtn");
const hangupBtn = document.getElementById("hangupBtn");
const copyShareBtn = document.getElementById("copyShareBtn");
const muteMicBtn = document.getElementById("muteMicBtn");
const muteRemoteBtn = document.getElementById("muteRemoteBtn");
const localVideo = document.getElementById("localVideo");
const remoteVideo = document.getElementById("remoteVideo");
const logEl = document.getElementById("log");

/** @type {VideoClient | null} */
let client = null;

function log(message) {
  logEl.textContent += `${new Date().toLocaleTimeString()} ${message}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function normalizeToken(token) {
  return token.trim().replace(/^Bearer\s+/i, "").replace(/\s+/g, "");
}

function normalizeServerUrl(serverUrl) {
  const trimmed = serverUrl.trim();

  if (!trimmed) {
    throw new Error("Server URL is required");
  }

  let parsed;

  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(
      "Invalid server URL — use http://127.0.0.1:3004 (include http://)",
    );
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Server URL must use http:// or https://");
  }

  return parsed.origin;
}

function wifiServerUrl() {
  const protocol = window.location.protocol === "https:" ? "https:" : "http:";
  return `${protocol}//${window.location.hostname}:3004`;
}

function buildShareLink() {
  const roomId = roomIdInput.value.trim() || client?.roomId;

  if (!roomId) {
    throw new Error("Room ID is required to build a share link");
  }

  const serverUrl = normalizeServerUrl(serverUrlInput.value);
  const params = new URLSearchParams({
    room: roomId,
    server: serverUrl,
  });

  return `${window.location.origin}${window.location.pathname}?${params.toString()}`;
}

function updateShareLinkField() {
  try {
    shareLinkInput.value = buildShareLink();
    copyShareBtn.disabled = false;
  } catch {
    shareLinkInput.value = "";
    copyShareBtn.disabled = !roomIdInput.value.trim();
  }
}

function setInCallControls(enabled) {
  hangupBtn.disabled = !enabled;
  muteMicBtn.disabled = !enabled;
  muteRemoteBtn.disabled = !enabled;
  connectBtn.disabled = enabled;
}

function updateMuteMicButton() {
  if (!client) {
    muteMicBtn.textContent = "Mute mic";
    return;
  }

  muteMicBtn.textContent = client.isMicMuted() ? "Unmute mic" : "Mute mic";
}

function updateMuteRemoteButton() {
  if (!client) {
    muteRemoteBtn.textContent = "Mute remote audio";
    return;
  }

  muteRemoteBtn.textContent = client.isRemoteAudioMuted()
    ? "Unmute remote audio"
    : "Mute remote audio";
}

function applyQueryParams() {
  const params = new URLSearchParams(window.location.search);
  const room = params.get("room");
  const server = params.get("server");

  if (server) {
    serverUrlInput.value = server;
  } else if (
    window.location.hostname !== "localhost" &&
    window.location.hostname !== "127.0.0.1"
  ) {
    serverUrlInput.value = wifiServerUrl();
  }

  if (room) {
    roomIdInput.value = room;
    log(`Loaded room from link: ${room}`);
  }

  updateShareLinkField();
}

async function fetchDevToken(userId) {
  const serverUrl = normalizeServerUrl(serverUrlInput.value);
  const response = await fetch(
    `${serverUrl}/v1/dev/token?userId=${encodeURIComponent(userId)}`,
  );

  if (!response.ok) {
    throw new Error(`Could not get dev token (${response.status})`);
  }

  const payload = await response.json();
  tokenInput.value = payload.token;
  log(`Loaded JWT for ${payload.userId}`);
}

useWifiServerBtn.addEventListener("click", () => {
  serverUrlInput.value = wifiServerUrl();
  log(`Server URL set to ${serverUrlInput.value}`);
  updateShareLinkField();
});

tokenUserABtn.addEventListener("click", async () => {
  try {
    await fetchDevToken("user-a");
  } catch (error) {
    log(`error: ${error instanceof Error ? error.message : String(error)}`);
  }
});

tokenUserBBtn.addEventListener("click", async () => {
  try {
    await fetchDevToken("user-b");
  } catch (error) {
    log(`error: ${error instanceof Error ? error.message : String(error)}`);
  }
});

tokenUserCBtn.addEventListener("click", async () => {
  try {
    await fetchDevToken("user-c");
  } catch (error) {
    log(`error: ${error instanceof Error ? error.message : String(error)}`);
  }
});

roomIdInput.addEventListener("input", updateShareLinkField);

copyShareBtn.addEventListener("click", async () => {
  try {
    const link = buildShareLink();
    await navigator.clipboard.writeText(link);
    log("Share link copied — send to staff on same Wi‑Fi");
  } catch (error) {
    log(`error: ${error instanceof Error ? error.message : String(error)}`);
  }
});

connectBtn.addEventListener("click", async () => {
  let serverUrl;
  let token;

  try {
    serverUrl = normalizeServerUrl(serverUrlInput.value);
    token = normalizeToken(tokenInput.value);
  } catch (error) {
    log(`error: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const roomId = roomIdInput.value.trim();

  if (!token) {
    log("JWT token is required — click Get token or paste a JWT");
    return;
  }

  connectBtn.disabled = true;

  try {
    client = await VideoClient.connect({
      serverUrl,
      token,
      roomId: roomId || undefined,
      localVideo,
      remoteVideo,
    });

    log(`Connected as ${client.userId} in room ${client.roomId}`);

    roomIdInput.value = client.roomId;
    updateShareLinkField();

    const shareLink = buildShareLink();
    window.history.replaceState({}, "", shareLink);
    log(`Share link ready — copy and send to staff: ${shareLink}`);

    client.on((event) => {
      log(`event: ${JSON.stringify({ ...event, stream: undefined })}`);
    });

    setInCallControls(true);
    updateMuteMicButton();
    updateMuteRemoteButton();
  } catch (error) {
    log(`error: ${error instanceof Error ? error.message : String(error)}`);
    connectBtn.disabled = false;
  }
});

muteMicBtn.addEventListener("click", () => {
  if (!client) {
    return;
  }

  client.setMicMuted(!client.isMicMuted());
  updateMuteMicButton();
  log(client.isMicMuted() ? "Microphone muted" : "Microphone unmuted");
});

muteRemoteBtn.addEventListener("click", () => {
  if (!client) {
    return;
  }

  client.setRemoteAudioMuted(!client.isRemoteAudioMuted());
  updateMuteRemoteButton();
  log(
    client.isRemoteAudioMuted()
      ? "Remote audio muted (for you only)"
      : "Remote audio unmuted",
  );
});

hangupBtn.addEventListener("click", () => {
  client?.hangup();
  client = null;
  setInCallControls(false);
  copyShareBtn.disabled = !roomIdInput.value.trim();
  updateMuteMicButton();
  updateMuteRemoteButton();
  log("Hung up");
});

applyQueryParams();
