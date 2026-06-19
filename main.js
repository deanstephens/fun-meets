// Fun Meets — local webcam control + N-peer WebRTC mesh.
//
// Responsibilities here:
//   * capture the local camera/mic,
//   * let the participant move their own tile around the stage with WASD,
//   * join a serverless mesh room (see mesh.js) and render a tile per remote
//     participant as their media streams arrive.
//
// Movement uses a small game loop: keys set a velocity, and on every animation
// frame the local tile position is integrated and clamped to the stage.
// Remote tiles are laid out automatically; per-peer position sync is a later
// milestone, so remote tiles are not yet movable.

import { joinRoom } from "./mesh.js";

const SPEED = 420; // pixels per second at full tilt

const stage = document.getElementById("stage");
const selfTile = document.getElementById("self");
const selfVideo = document.getElementById("self-video");
const overlay = document.getElementById("overlay");
const controls = document.getElementById("controls");
const startBtn = document.getElementById("start-btn");
const errorEl = document.getElementById("error");
const topbar = document.getElementById("topbar");
const roomNameEl = document.getElementById("room-name");
const peerCountEl = document.getElementById("peer-count");
const copyLinkBtn = document.getElementById("copy-link");

// Local tile position (top-left corner, in stage pixels).
const pos = { x: 0, y: 0 };

// Which movement keys are currently held.
const held = { up: false, down: false, left: false, right: false };

const KEY_MAP = {
  w: "up",
  s: "down",
  a: "left",
  d: "right",
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};

let lastFrame = null;
let running = false;
let localStream = null;
let session = null;

// id -> { el, video } for each connected remote participant.
const remoteTiles = new Map();
// id -> { nx, ny } latest normalized position broadcast by that peer.
const remotePositions = new Map();
let remoteSlot = 0;

// Position-broadcast throttle.
let lastPosSent = 0;
let wasMoving = false;
const POS_INTERVAL = 50; // ms between position updates while moving (~20Hz)

async function start() {
  errorEl.hidden = true;
  startBtn.disabled = true;
  startBtn.textContent = "Requesting camera…";

  try {
    localStream = await getStream();
    selfVideo.srcObject = localStream;
  } catch (err) {
    showError(err);
    startBtn.disabled = false;
    startBtn.textContent = "Enable camera & join";
    return;
  }

  // Reveal the local tile and center it on the stage.
  selfTile.hidden = false;
  centerTile();
  applyPosition();

  overlay.hidden = true;
  controls.hidden = false;
  topbar.hidden = false;
  startBtn.disabled = false;
  startBtn.textContent = "Enable camera & join";

  if (!running) {
    running = true;
    lastFrame = null;
    requestAnimationFrame(loop);
  }

  // Join the mesh room.
  const room = getRoom();
  roomNameEl.textContent = room;
  session = joinRoom({
    room,
    localStream,
    onStatus: (s) => {
      if (typeof s.peerCount === "number") peerCountEl.textContent = String(s.peerCount);
      if (s.error) console.warn("[mesh] status error:", s.error);
    },
    onPeerStream: (id, stream) => addRemoteTile(id, stream),
    onPeerLeft: (id) => removeRemoteTile(id),
    // A peer just connected — send them where our tile currently is.
    onPeerJoin: (id) => session && session.sendTo(id, posMessage()),
    // A peer told us where their tile is.
    onMessage: (id, data) => {
      if (data && data.type === "pos") {
        remotePositions.set(id, { nx: data.nx, ny: data.ny });
        applyRemotePosition(id);
      }
    },
  });
}

// Prefer camera + mic; fall back to camera-only if no mic is available.
async function getStream() {
  try {
    return await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (err) {
    if (err && (err.name === "NotFoundError" || err.name === "OverconstrainedError")) {
      return await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    }
    throw err;
  }
}

function getRoom() {
  const url = new URL(window.location.href);
  let room = url.searchParams.get("room");
  if (!room) {
    room = Math.random().toString(36).slice(2, 8);
    url.searchParams.set("room", room);
    window.history.replaceState(null, "", url);
  }
  return room;
}

function showError(err) {
  let msg = "Could not access the camera.";
  if (err && err.name === "NotAllowedError") {
    msg = "Camera/mic permission was denied. Allow it and try again.";
  } else if (err && err.name === "NotFoundError") {
    msg = "No camera was found on this device.";
  } else if (err && err.message) {
    msg = err.message;
  }
  errorEl.textContent = msg;
  errorEl.hidden = false;
}

// ---- Remote tiles -------------------------------------------------------

function shortId(id) {
  return id.slice(-4);
}

// The area the tile's top-left corner can occupy, in stage pixels. Positions
// are exchanged as fractions of this area so they map correctly between peers
// whose windows are different sizes.
function movableArea() {
  return {
    mx: Math.max(1, stage.clientWidth - tileSize()),
    my: Math.max(1, stage.clientHeight - tileSize()),
  };
}

function clamp01(v) {
  return Math.min(1, Math.max(0, v));
}

function localNorm() {
  const { mx, my } = movableArea();
  return { nx: clamp01(pos.x / mx), ny: clamp01(pos.y / my) };
}

function posMessage() {
  const n = localNorm();
  return { type: "pos", nx: n.nx, ny: n.ny };
}

function broadcastPosition() {
  if (session) session.broadcast(posMessage());
}

function applyRemotePosition(id) {
  const tile = remoteTiles.get(id);
  const p = remotePositions.get(id);
  if (!tile || !p) return;
  const { mx, my } = movableArea();
  tile.el.style.transform = `translate(${p.nx * mx}px, ${p.ny * my}px)`;
}

// Fallback layout for a tile we haven't received a position for yet.
function placeRemote(el) {
  const size = tileSize();
  const gap = 16;
  const cols = Math.max(1, Math.floor((stage.clientWidth - gap) / (size + gap)));
  const idx = remoteSlot++;
  const x = gap + (idx % cols) * (size + gap);
  const y = gap + Math.floor(idx / cols) * (size + gap);
  el.style.transform = `translate(${x}px, ${y}px)`;
}

function addRemoteTile(id, stream) {
  let tile = remoteTiles.get(id);
  if (!tile) {
    const el = document.createElement("div");
    el.className = "tile remote";

    const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;

    const label = document.createElement("div");
    label.className = "tile-label";
    label.textContent = shortId(id);

    el.appendChild(video);
    el.appendChild(label);
    stage.appendChild(el);

    tile = { el, video };
    remoteTiles.set(id, tile);

    // Use their reported position if we already have one, otherwise lay the
    // tile out in the fallback grid until a position update arrives.
    if (remotePositions.has(id)) applyRemotePosition(id);
    else placeRemote(el);
  }
  tile.video.srcObject = stream;
}

function removeRemoteTile(id) {
  const tile = remoteTiles.get(id);
  remotePositions.delete(id);
  if (!tile) return;
  try { tile.video.srcObject = null; } catch (_) {}
  tile.el.remove();
  remoteTiles.delete(id);
}

// ---- Local tile movement ------------------------------------------------

function tileSize() {
  return selfTile.offsetWidth || 180;
}

function centerTile() {
  pos.x = (stage.clientWidth - tileSize()) / 2;
  pos.y = (stage.clientHeight - tileSize()) / 2;
}

function clampPosition() {
  const max_x = Math.max(0, stage.clientWidth - tileSize());
  const max_y = Math.max(0, stage.clientHeight - tileSize());
  pos.x = Math.min(Math.max(0, pos.x), max_x);
  pos.y = Math.min(Math.max(0, pos.y), max_y);
}

function applyPosition() {
  selfTile.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
}

function loop(timestamp) {
  if (lastFrame === null) lastFrame = timestamp;
  const dt = Math.min((timestamp - lastFrame) / 1000, 0.05); // cap large gaps
  lastFrame = timestamp;

  let dx = (held.right ? 1 : 0) - (held.left ? 1 : 0);
  let dy = (held.down ? 1 : 0) - (held.up ? 1 : 0);

  if (dx !== 0 || dy !== 0) {
    // Normalize so diagonal movement isn't faster than axis-aligned.
    const len = Math.hypot(dx, dy);
    dx /= len;
    dy /= len;
    pos.x += dx * SPEED * dt;
    pos.y += dy * SPEED * dt;
    clampPosition();
    applyPosition();
    // Throttle position updates to peers while moving.
    if (timestamp - lastPosSent >= POS_INTERVAL) {
      broadcastPosition();
      lastPosSent = timestamp;
    }
    wasMoving = true;
  } else if (wasMoving) {
    // Send one final update so peers see the exact resting position.
    broadcastPosition();
    wasMoving = false;
  }

  requestAnimationFrame(loop);
}

function onKeyDown(e) {
  const dir = KEY_MAP[e.key];
  if (!dir) return;
  held[dir] = true;
  e.preventDefault();
}

function onKeyUp(e) {
  const dir = KEY_MAP[e.key];
  if (!dir) return;
  held[dir] = false;
  e.preventDefault();
}

// Keep the local tile inside the stage when the window is resized, and
// re-project remote tiles from their normalized positions to new pixel coords.
function onResize() {
  if (selfTile.hidden) return;
  clampPosition();
  applyPosition();
  remoteTiles.forEach((_, id) => applyRemotePosition(id));
}

async function copyInviteLink() {
  try {
    await navigator.clipboard.writeText(window.location.href);
    const original = copyLinkBtn.textContent;
    copyLinkBtn.textContent = "Copied!";
    setTimeout(() => { copyLinkBtn.textContent = original; }, 1500);
  } catch (_) {
    // Clipboard may be unavailable; fall back to selecting nothing silently.
  }
}

startBtn.addEventListener("click", start);
copyLinkBtn.addEventListener("click", copyInviteLink);
window.addEventListener("keydown", onKeyDown);
window.addEventListener("keyup", onKeyUp);
window.addEventListener("resize", onResize);
window.addEventListener("beforeunload", () => session && session.leave());
