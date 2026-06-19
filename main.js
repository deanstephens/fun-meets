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
import {
  AVATAR_OPTIONS, SLOT_LABELS, OPTION_LABELS, DEFAULT_AVATAR,
  normalizeAvatar, applyAvatar,
} from "./avatar.js";
import { EMOJIS, spawnShower, spawnThrow, spawnTrail } from "./emoji.js";
import {
  COLOR_PRESETS, PATTERN_PRESETS, imageCss, sanitizeBg, downscaleImage,
} from "./background.js";
import { createFaceFramer } from "./faceframe.js";
import { createSpatialAudio, gainForDistance } from "./spatialaudio.js";

const SPEED = 420; // pixels per second at full tilt

const stage = document.getElementById("stage");
const selfTile = document.getElementById("self");
const selfVideo = document.getElementById("self-video");
const overlay = document.getElementById("overlay");
const controls = document.getElementById("controls");
const startBtn = document.getElementById("start-btn");
const usernameInput = document.getElementById("username-input");
const errorEl = document.getElementById("error");
const topbar = document.getElementById("topbar");
const roomNameEl = document.getElementById("room-name");
const peerCountEl = document.getElementById("peer-count");
const copyLinkBtn = document.getElementById("copy-link");
const toggleBodyBtn = document.getElementById("toggle-body");
const toggleFrameBtn = document.getElementById("toggle-frame");
const toggleSpatialBtn = document.getElementById("toggle-spatial");
const sidebar = document.getElementById("sidebar");
const chatForm = document.getElementById("chat");
const chatInput = document.getElementById("chat-input");
const chatPanel = document.getElementById("chatpanel");
const chatLog = document.getElementById("chat-log");
const chatToggleBtn = document.getElementById("chat-toggle");
const chatUnreadEl = document.getElementById("chat-unread");

// Avatar customisation elements
const avatarSection = document.getElementById("avatarpanel");
const avatarToggleBtn = document.getElementById("avatar-toggle");
const avatarList = document.getElementById("avatar-list");

// Actions / cards / zones elements
const zoneLayer = document.getElementById("zone-layer");
const cardLayer = document.getElementById("card-layer");
const actionsEl = document.getElementById("actions");
const actionQueryInput = document.getElementById("action-query");
const actionList = document.getElementById("action-list");

// Emoji elements
const emojiLayer = document.getElementById("emoji-layer");
const emojiSection = document.getElementById("emojipanel");
const emojiToggleBtn = document.getElementById("emoji-toggle");
const emojiPalette = document.getElementById("emoji-palette");
const trailToggleBtn = document.getElementById("trail-toggle");

// Background elements
const bgSection = document.getElementById("bgpanel");
const bgToggleBtn = document.getElementById("bg-toggle");
const bgColors = document.getElementById("bg-colors");
const bgPatterns = document.getElementById("bg-patterns");
const bgUrl = document.getElementById("bg-url");
const bgUrlApply = document.getElementById("bg-url-apply");
const bgFile = document.getElementById("bg-file");
const bgReset = document.getElementById("bg-reset");

// Dev console elements
const consoleSection = document.getElementById("devconsole");
const consoleToggleBtn = document.getElementById("console-toggle");
const dcMyId = document.getElementById("dc-myid");
const dcRole = document.getElementById("dc-role");
const dcRoom = document.getElementById("dc-room");
const dcCount = document.getElementById("dc-count");
const dcPeers = document.getElementById("dc-peers");
const dcLog = document.getElementById("dc-log");

const BUBBLE_MS = 6000; // how long a speech bubble stays up
const LOG_LIMIT = 200; // max lines kept in the dev console log
let unreadCount = 0;

// id -> status string, for the dev console connections list.
const peerStatuses = new Map();

// id -> avatar config for each remote participant.
const remoteAvatars = new Map();

// id -> chosen display name for each remote participant.
const remoteNames = new Map();

// Our own display name (persisted across reloads). Initialised in the setup
// section below, once the name word-lists are defined.
let username = "";

// Our own avatar configuration (persisted across reloads).
const avatarConfig = loadAvatar();

// Emoji state: the currently-selected emoji (for throw/trail) and trail on/off.
const emojiState = loadEmoji();
let lastTrail = 0;
const TRAIL_INTERVAL = 130; // ms between trail drops while moving

// Cards dropped on the shared board: id -> { id, nx, ny, text, el, ta, sendTimer }.
const cards = new Map();
const CARD_MAX = 500;

// Huddle/breakout zones: id -> { id, cx, cy, r, el }. People in the same zone
// hear each other clearly; everyone else is muffled.
const zones = new Map();
const ZONE_MUFFLED = 0.08;

// The room's current background CSS ("" = the stylesheet default). Shared.
// The host is authoritative: it (re)sends the room background to new joiners,
// so a newcomer's default doesn't clobber what the room already chose.
let currentBg = "";
let amHost = false;

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
let faceFramer = null;
let faceFrameOn = loadFaceFramePref();

// Proximity-based spatial audio (shapes received audio by avatar distance).
const spatialAudio = createSpatialAudio();
let spatialOn = loadSpatialPref();
window.__spatialAudio = spatialAudio; // debug/inspection handle

// id -> { el, head, video, veil } for each known remote participant.
const remoteTiles = new Map();
// id -> { nx, ny } latest normalized position broadcast by that peer.
const remotePositions = new Map();
// id -> timeout handle that clears a remote tile's "walking" state.
const remoteWalkTimers = new Map();
let remoteSlot = 0;

// Position-broadcast throttle.
let lastPosSent = 0;
let wasMoving = false;
const POS_INTERVAL = 50; // ms between position updates while moving (~20Hz)

const STATUS_TEXT = {
  connecting: "connecting…",
  failed: "couldn’t connect",
  connected: "",
};

async function start() {
  errorEl.hidden = true;
  startBtn.disabled = true;
  startBtn.textContent = "Requesting camera…";

  // Lock in the chosen display name before joining.
  username = sanitizeName(usernameInput.value) || username;
  saveUsername();

  try {
    const raw = await getStream();
    // Route the camera through the face-framer (crops/zooms to the face) so the
    // framed video is what we show and send. Falls back to the raw stream if the
    // pipeline can't be set up.
    try {
      faceFramer = createFaceFramer(raw, { enabled: faceFrameOn });
      localStream = faceFramer.stream;
    } catch (e) {
      console.warn("[faceframe] setup failed, using raw stream:", e);
      localStream = raw;
    }
    selfVideo.srcObject = localStream;
    updateFrameBtn();
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
  sidebar.hidden = false;
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
  dcRoom.textContent = room;
  session = joinRoom({
    room,
    localStream,
    onStatus: (s) => {
      if (typeof s.peerCount === "number") {
        peerCountEl.textContent = String(s.peerCount);
        dcCount.textContent = String(s.peerCount);
      }
      if (s.myId) dcMyId.textContent = s.myId;
      if (typeof s.isHost === "boolean") {
        amHost = s.isHost;
        dcRole.textContent = s.isHost ? "host" : "guest";
      }
      if (s.error) {
        console.warn("[mesh] status error:", s.error);
        appendConsoleLog("status error: " + s.error);
      }
    },
    onPeerStream: (id, stream) => addRemoteStream(id, stream),
    onPeerLeft: (id) => {
      removeRemoteTile(id);
      peerStatuses.delete(id);
      remoteNames.delete(id);
      renderConsolePeers();
    },
    // Per-peer connection status (connecting / connected / failed).
    onPeerStatus: (id, status) => {
      setRemoteStatus(id, status);
      peerStatuses.set(id, status);
      renderConsolePeers();
    },
    onLog: (line) => appendConsoleLog(line),
    // A peer just connected — send them our current position, look, and the
    // room background so they match.
    onPeerJoin: (id) => {
      if (!session) return;
      session.sendTo(id, posMessage());
      session.sendTo(id, avatarMessage());
      session.sendTo(id, nameMessage());
      // Only the host hands out shared board state (background + cards), so a
      // newcomer's empty state doesn't overwrite it.
      if (amHost) {
        session.sendTo(id, { type: "background", css: currentBg });
        cards.forEach((c) => session.sendTo(id, cardMessage(c)));
        zones.forEach((z) => session.sendTo(id, zoneMessage(z)));
      }
    },
    // A peer told us where their tile is, or said something.
    onMessage: (id, data) => {
      if (!data) return;
      if (data.type === "pos") {
        const prev = remotePositions.get(id);
        const moved = !prev ||
          Math.abs(prev.nx - data.nx) > 0.001 ||
          Math.abs(prev.ny - data.ny) > 0.001;
        // Flip the remote face to match its horizontal direction of travel.
        const tile = remoteTiles.get(id);
        if (tile && prev) {
          if (data.nx > prev.nx + 0.002) tile.el.classList.remove("facing-left");
          else if (data.nx < prev.nx - 0.002) tile.el.classList.add("facing-left");
        }
        remotePositions.set(id, { nx: data.nx, ny: data.ny });
        applyRemotePosition(id);
        if (moved) markRemoteWalking(id); // animate their body while moving
      } else if (data.type === "chat" && typeof data.text === "string") {
        const text = data.text.slice(0, 200);
        const tile = ensureRemoteTile(id);
        showBubble(tile.el, text);
        addChatMessage(displayName(id), text, false);
      } else if (data.type === "name") {
        remoteNames.set(id, sanitizeName(data.name) || shortId(id));
        applyRemoteName(id);
      } else if (data.type === "avatar") {
        const cfg = normalizeAvatar(data.config);
        remoteAvatars.set(id, cfg);
        applyAvatar(ensureRemoteTile(id).el, cfg);
      } else if (data.type === "emoji") {
        const emoji = typeof data.emoji === "string" ? data.emoji.slice(0, 8) : "";
        if (!emoji) return;
        const c = remoteCenter(id);
        if (data.action === "shower") {
          spawnShower(emojiLayer, emoji, c.x, c.y);
        } else if (data.action === "trail") {
          spawnTrail(emojiLayer, emoji, c.x, c.y);
        } else if (data.action === "throw") {
          spawnThrow(emojiLayer, emoji, c.x, c.y,
            clamp01(data.nx) * stage.clientWidth, clamp01(data.ny) * stage.clientHeight);
        }
      } else if (data.type === "background") {
        applyBackground(sanitizeBg(data.css));
      } else if (data.type === "card" && data.op === "upsert" && data.card) {
        upsertCard(data.card, false);
      } else if (data.type === "zone") {
        if (data.op === "upsert" && data.zone) upsertZone(data.zone);
        else if (data.op === "clear") clearZones(false);
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

// ---- Usernames ----------------------------------------------------------

const NAME_ADJ = ["Sunny", "Brave", "Clever", "Lucky", "Swift", "Jolly", "Cosmic", "Mellow", "Witty", "Zippy"];
const NAME_NOUN = ["Otter", "Fox", "Panda", "Comet", "Maple", "Robin", "Pixel", "Mango", "Heron", "Willow"];

function randomName() {
  const a = NAME_ADJ[(Math.random() * NAME_ADJ.length) | 0];
  const n = NAME_NOUN[(Math.random() * NAME_NOUN.length) | 0];
  return a + n;
}

// Trim, strip control characters, and cap the length. Returns "" if empty.
function sanitizeName(s) {
  if (typeof s !== "string") return "";
  return s.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 24);
}

function loadUsername() {
  try {
    return sanitizeName(localStorage.getItem("funmeets-username")) || randomName();
  } catch (_) {
    return randomName();
  }
}

function saveUsername() {
  try { localStorage.setItem("funmeets-username", username); } catch (_) {}
}

function nameMessage() {
  return { type: "name", name: username };
}

function broadcastName() {
  if (session) session.broadcast(nameMessage());
}

// What to show for a peer: their chosen name, falling back to the short id.
function displayName(id) {
  return remoteNames.get(id) || shortId(id);
}

// A peer's name arrived (or changed) — update everywhere it shows.
function applyRemoteName(id) {
  const tile = remoteTiles.get(id);
  if (tile && tile.label) tile.label.textContent = displayName(id);
  renderConsolePeers();
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

// Create the tile for a peer if it doesn't exist yet. A tile can appear before
// any video arrives (while still connecting), so it starts as a placeholder
// with a status veil and is filled in once the stream is flowing.
function ensureRemoteTile(id) {
  let tile = remoteTiles.get(id);
  if (tile) return tile;

  const el = document.createElement("div");
  el.className = "tile remote";
  el.dataset.status = "connecting";

  const head = document.createElement("div");
  head.className = "head";

  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;

  const label = document.createElement("div");
  label.className = "tile-label";
  label.textContent = displayName(id);

  const dot = document.createElement("div");
  dot.className = "status-dot";

  const veil = document.createElement("div");
  veil.className = "veil";
  veil.textContent = STATUS_TEXT.connecting;

  // Video + veil are clipped inside the circular head; label + status dot live
  // on the unclipped wrapper so they aren't cut off by the circle.
  head.append(video, veil);
  el.append(head, label, dot);
  applyAvatar(el, normalizeAvatar(remoteAvatars.get(id)));
  stage.appendChild(el);

  tile = { el, head, video, veil, label };
  remoteTiles.set(id, tile);

  // Use their reported position if we have one, otherwise the fallback grid.
  if (remotePositions.has(id)) applyRemotePosition(id);
  else placeRemote(el);
  return tile;
}

function setRemoteStatus(id, status) {
  const tile = ensureRemoteTile(id);
  tile.el.dataset.status = status;
  tile.veil.textContent = STATUS_TEXT[status] || "";
}

function addRemoteStream(id, stream) {
  const tile = ensureRemoteTile(id);
  tile.video.srcObject = stream;
  tile.el.classList.add("has-video"); // hides the veil
  // Route the audio through spatial audio (distance-based volume).
  spatialAudio.addPeer(id, stream, tile.video);
  // Media flowing implies a working connection.
  if (tile.el.dataset.status !== "connected") setRemoteStatus(id, "connected");
}

// Show (or refresh) a speech bubble above a tile's head. Reuses one bubble
// element per tile; the latest message replaces any current one.
function showBubble(tileEl, text) {
  let bubble = tileEl.__bubble;
  if (!bubble) {
    bubble = document.createElement("div");
    bubble.className = "bubble";
    tileEl.appendChild(bubble);
    tileEl.__bubble = bubble;
  }
  bubble.textContent = text;
  bubble.classList.add("show");
  tileEl.classList.add("has-bubble");
  if (tileEl.__bubbleTimer) clearTimeout(tileEl.__bubbleTimer);
  tileEl.__bubbleTimer = setTimeout(() => {
    bubble.classList.remove("show");
    tileEl.classList.remove("has-bubble");
    tileEl.__bubbleTimer = null;
  }, BUBBLE_MS);
}

// Briefly flag a remote tile as walking so its body animates while it moves.
function markRemoteWalking(id) {
  const tile = remoteTiles.get(id);
  if (!tile) return;
  tile.el.classList.add("walking");
  const prev = remoteWalkTimers.get(id);
  if (prev) clearTimeout(prev);
  remoteWalkTimers.set(id, setTimeout(() => {
    tile.el.classList.remove("walking");
    remoteWalkTimers.delete(id);
  }, 250));
}

function removeRemoteTile(id) {
  const tile = remoteTiles.get(id);
  spatialAudio.removePeer(id);
  remotePositions.delete(id);
  remoteAvatars.delete(id);
  const t = remoteWalkTimers.get(id);
  if (t) { clearTimeout(t); remoteWalkTimers.delete(id); }
  if (!tile) return;
  if (tile.el.__bubbleTimer) clearTimeout(tile.el.__bubbleTimer);
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
  const moving = dx !== 0 || dy !== 0;

  // Animate our own stick-figure body while moving.
  selfTile.classList.toggle("walking", moving);

  // Face the direction of horizontal movement (keep facing when moving purely
  // vertically or standing still). dx is still the raw -1/0/1 here.
  if (dx > 0) selfTile.classList.remove("facing-left");
  else if (dx < 0) selfTile.classList.add("facing-left");

  if (moving) {
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
    // Drop an emoji trail behind us if it's enabled.
    if (emojiState.trail && timestamp - lastTrail >= TRAIL_INTERVAL) {
      lastTrail = timestamp;
      const c = localCenter();
      spawnTrail(emojiLayer, emojiState.selected, c.x - dx * 26, c.y - dy * 26);
      if (session) session.broadcast({ type: "emoji", action: "trail", emoji: emojiState.selected });
    }
    wasMoving = true;
  } else if (wasMoving) {
    // Send one final update so peers see the exact resting position.
    broadcastPosition();
    wasMoving = false;
  }

  // Which huddle zone we're in (highlight it), then update spatial-audio
  // volumes from positions + zone membership. Cheap; runs every frame so it
  // tracks our movement and peers' movement.
  const myZone = zones.size ? zoneContaining(localCenter()) : null;
  if (zones.size) zones.forEach((z) => z.el.classList.toggle("mine", z === myZone));
  spatialAudio.update((id) => peerTargetGain(id, myZone));

  requestAnimationFrame(loop);
}

function isTyping() {
  const el = document.activeElement;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
}

// Drop any held movement keys (e.g. when focus moves into the chat box, so the
// avatar doesn't keep gliding because we never see the keyup).
function resetHeld() {
  held.up = held.down = held.left = held.right = false;
  selfTile.classList.remove("walking");
}

function onKeyDown(e) {
  if (isTyping()) {
    if (e.key === "Escape" && document.activeElement) document.activeElement.blur();
    return; // let the input field handle the keystroke
  }
  // "/" opens the actions menu.
  if (e.key === "/" && running) {
    openActions();
    e.preventDefault();
    return;
  }
  // Enter focuses the chat box for a quick message (expanding it if collapsed).
  if (e.key === "Enter" && !sidebar.hidden) {
    expandChat();
    chatInput.focus();
    e.preventDefault();
    return;
  }
  // Number keys 1–9 shower the bound emoji around you.
  if (e.key >= "1" && e.key <= "9" && running) {
    const emoji = EMOJIS[Number(e.key) - 1];
    if (emoji) {
      showerEmoji(emoji);
      e.preventDefault();
    }
    return;
  }
  const dir = KEY_MAP[e.key];
  if (!dir) return;
  held[dir] = true;
  e.preventDefault();
}

function onKeyUp(e) {
  if (isTyping()) return;
  const dir = KEY_MAP[e.key];
  if (!dir) return;
  held[dir] = false;
  e.preventDefault();
}

function sendChat(e) {
  e.preventDefault();
  const text = chatInput.value.trim().slice(0, 200);
  chatInput.value = "";
  chatInput.blur(); // return control to movement
  if (!text) return;
  showBubble(selfTile, text); // show our own bubble locally
  addChatMessage("You", text, true);
  if (session) session.broadcast({ type: "chat", text });
}

// ---- Persistent chat panel ----

function addChatMessage(who, text, isYou) {
  const msg = document.createElement("div");
  msg.className = "msg" + (isYou ? " you" : "");
  const w = document.createElement("span");
  w.className = "who";
  w.textContent = who;
  msg.append(w, document.createTextNode(text));
  chatLog.appendChild(msg);
  chatLog.scrollTop = chatLog.scrollHeight; // keep the latest in view
  if (chatPanel.classList.contains("collapsed")) {
    unreadCount += 1;
    chatUnreadEl.textContent = String(unreadCount);
    chatUnreadEl.hidden = false;
  }
}

function clearUnread() {
  unreadCount = 0;
  chatUnreadEl.hidden = true;
}

function setChatCollapsed(collapsed) {
  chatPanel.classList.toggle("collapsed", collapsed);
  chatToggleBtn.textContent = collapsed ? "Show" : "Hide";
  if (!collapsed) clearUnread();
}

function toggleChat() {
  setChatCollapsed(!chatPanel.classList.contains("collapsed"));
}

function expandChat() {
  setChatCollapsed(false);
}

function toggleConsole() {
  const collapsed = !consoleSection.classList.contains("collapsed");
  consoleSection.classList.toggle("collapsed", collapsed);
  consoleToggleBtn.textContent = collapsed ? "Show" : "Hide";
}

function toggleAvatar() {
  const collapsed = !avatarSection.classList.contains("collapsed");
  avatarSection.classList.toggle("collapsed", collapsed);
  avatarToggleBtn.textContent = collapsed ? "Show" : "Hide";
}

// ---- Avatar customisation ----

function loadAvatar() {
  try {
    return normalizeAvatar(JSON.parse(localStorage.getItem("funmeets-avatar")));
  } catch (_) {
    return { ...DEFAULT_AVATAR };
  }
}

function saveAvatar() {
  try {
    localStorage.setItem("funmeets-avatar", JSON.stringify(avatarConfig));
  } catch (_) {}
}

function avatarMessage() {
  return { type: "avatar", config: avatarConfig };
}

function broadcastAvatar() {
  if (session) session.broadcast(avatarMessage());
}

// Build the customisation controls: one row of option buttons per slot.
function buildAvatarUI() {
  Object.keys(AVATAR_OPTIONS).forEach((slot) => {
    const row = document.createElement("div");
    row.className = "avatar-row";

    const label = document.createElement("span");
    label.className = "alabel";
    label.textContent = SLOT_LABELS[slot];

    const opts = document.createElement("div");
    opts.className = "opts";
    AVATAR_OPTIONS[slot].forEach((val) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "opt" + (avatarConfig[slot] === val ? " active" : "");
      btn.textContent = OPTION_LABELS[val] || val;
      btn.dataset.slot = slot;
      btn.dataset.val = val;
      btn.addEventListener("click", () => selectAvatar(slot, val));
      opts.appendChild(btn);
    });

    row.append(label, opts);
    avatarList.appendChild(row);
  });
}

function selectAvatar(slot, val) {
  avatarConfig[slot] = val;
  saveAvatar();
  applyAvatar(selfTile, avatarConfig);
  avatarList
    .querySelectorAll('.opt[data-slot="' + slot + '"]')
    .forEach((b) => b.classList.toggle("active", b.dataset.val === val));
  broadcastAvatar();
}

// ---- Emojis ----

function loadEmoji() {
  try {
    const s = JSON.parse(localStorage.getItem("funmeets-emoji")) || {};
    return { selected: EMOJIS.includes(s.selected) ? s.selected : EMOJIS[0], trail: !!s.trail };
  } catch (_) {
    return { selected: EMOJIS[0], trail: false };
  }
}

function saveEmoji() {
  try {
    localStorage.setItem("funmeets-emoji", JSON.stringify(emojiState));
  } catch (_) {}
}

// Centre of our own avatar, in stage pixels.
function localCenter() {
  const ts = tileSize();
  return { x: pos.x + ts / 2, y: pos.y + ts / 2 };
}

// Centre of a remote avatar, from its last known normalized position.
function remoteCenter(id) {
  const ts = tileSize();
  const p = remotePositions.get(id);
  if (p) {
    const { mx, my } = movableArea();
    return { x: p.nx * mx + ts / 2, y: p.ny * my + ts / 2 };
  }
  const tile = remoteTiles.get(id);
  const m = tile && /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(tile.el.style.transform || "");
  if (m) return { x: parseFloat(m[1]) + ts / 2, y: parseFloat(m[2]) + ts / 2 };
  return { x: stage.clientWidth / 2, y: stage.clientHeight / 2 };
}

function showerEmoji(emoji) {
  const c = localCenter();
  spawnShower(emojiLayer, emoji, c.x, c.y);
  if (session) session.broadcast({ type: "emoji", action: "shower", emoji });
}

function throwEmoji(tx, ty) {
  const c = localCenter();
  const emoji = emojiState.selected;
  spawnThrow(emojiLayer, emoji, c.x, c.y, tx, ty);
  if (session) {
    session.broadcast({
      type: "emoji", action: "throw", emoji,
      nx: tx / stage.clientWidth, ny: ty / stage.clientHeight,
    });
  }
}

function buildEmojiUI() {
  EMOJIS.forEach((emoji, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "emoji-opt" + (emojiState.selected === emoji ? " active" : "");
    btn.dataset.emoji = emoji;
    btn.innerHTML = `<span class="ec">${emoji}</span>` + (i < 9 ? `<span class="ek">${i + 1}</span>` : "");
    btn.addEventListener("click", () => selectEmoji(emoji));
    emojiPalette.appendChild(btn);
  });
  updateTrailBtn();
}

function selectEmoji(emoji) {
  emojiState.selected = emoji;
  saveEmoji();
  emojiPalette
    .querySelectorAll(".emoji-opt")
    .forEach((b) => b.classList.toggle("active", b.dataset.emoji === emoji));
}

function toggleTrail() {
  emojiState.trail = !emojiState.trail;
  saveEmoji();
  updateTrailBtn();
}

function updateTrailBtn() {
  trailToggleBtn.textContent = "Trail: " + (emojiState.trail ? "On" : "Off");
  trailToggleBtn.classList.toggle("active", emojiState.trail);
}

function toggleEmojiPanel() {
  const collapsed = !emojiSection.classList.contains("collapsed");
  emojiSection.classList.toggle("collapsed", collapsed);
  emojiToggleBtn.textContent = collapsed ? "Show" : "Hide";
}

// ---- Room background ----

function applyBackground(css) {
  currentBg = css || "";
  stage.style.background = currentBg; // "" falls back to the stylesheet gradient
  highlightBg();
}

// Apply locally and share with the room.
function setBackground(css) {
  applyBackground(css);
  if (session) session.broadcast({ type: "background", css: currentBg });
}

function highlightBg() {
  document
    .querySelectorAll(".bg-swatch")
    .forEach((b) => b.classList.toggle("active", b.dataset.css === currentBg));
}

function buildBgUI() {
  const swatch = (p) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "bg-swatch";
    b.title = p.label;
    b.dataset.css = p.reset ? "" : p.css; // "Default" resets to the stylesheet
    b.style.background = p.css;
    b.style.backgroundSize = "cover";
    b.addEventListener("click", () => setBackground(b.dataset.css));
    return b;
  };
  COLOR_PRESETS.forEach((p) => bgColors.appendChild(swatch(p)));
  PATTERN_PRESETS.forEach((p) => bgPatterns.appendChild(swatch(p)));
  highlightBg();
}

function applyImageUrl() {
  const url = bgUrl.value.trim();
  if (url) setBackground(imageCss(url));
}

function onBgFile() {
  const file = bgFile.files && bgFile.files[0];
  if (!file) return;
  downscaleImage(file, 1280, (dataUrl) => {
    if (dataUrl) setBackground(imageCss(dataUrl));
  });
  bgFile.value = "";
}

function toggleBgPanel() {
  const collapsed = !bgSection.classList.contains("collapsed");
  bgSection.classList.toggle("collapsed", collapsed);
  bgToggleBtn.textContent = collapsed ? "Show" : "Hide";
}

// ---- Actions (slash menu) ----

const ACTIONS = [
  {
    id: "create-card",
    label: "Create card",
    description: "Drop an editable card where you're standing",
    run: createCardAtMe,
  },
  {
    id: "create-zone",
    label: "Create huddle zone",
    description: "Make a zone — people inside hear each other, muffled to outside",
    run: createZoneAtMe,
  },
  {
    id: "clear-zones",
    label: "Clear huddle zones",
    description: "Remove all huddle zones from the board",
    run: () => clearZones(true),
  },
];

let actionFiltered = [];
let actionHi = 0;

function openActions() {
  actionsEl.hidden = false;
  actionQueryInput.value = "";
  renderActions("");
  actionQueryInput.focus();
}

function closeActions() {
  if (actionsEl.hidden) return;
  actionsEl.hidden = true;
  actionQueryInput.blur();
  resetHeld();
}

// Fuzzy subsequence score: query chars must appear in order in text. Returns
// -Infinity for no match; higher is better (rewards consecutive runs and
// earlier starts) so results can be ranked.
function fuzzyScore(q, text) {
  if (!q) return 0;
  let score = 0;
  let ti = 0;
  let streak = 0;
  let first = -1;
  for (const ch of q) {
    let found = -1;
    for (let j = ti; j < text.length; j++) {
      if (text[j] === ch) { found = j; break; }
    }
    if (found === -1) return -Infinity;
    if (first === -1) first = found;
    streak = found === ti ? streak + 1 : 0;
    score += 1 + streak * 2;
    ti = found + 1;
  }
  return score - first * 0.1;
}

function renderActions(raw) {
  // A stray leading "/" (from the trigger key) is ignored; fuzzy-match the rest.
  const q = raw.replace(/^\/+/, "").trim().toLowerCase();
  actionFiltered = ACTIONS
    .map((a) => ({
      a,
      s: Math.max(
        fuzzyScore(q, a.id.toLowerCase()),
        fuzzyScore(q, a.label.toLowerCase().replace(/\s+/g, ""))
      ),
    }))
    .filter((x) => x.s > -Infinity)
    .sort((x, y) => y.s - x.s)
    .map((x) => x.a);
  actionHi = 0;
  actionList.textContent = "";
  if (!actionFiltered.length) {
    const li = document.createElement("li");
    li.className = "action-empty";
    li.textContent = "No matching actions";
    actionList.appendChild(li);
    return;
  }
  actionFiltered.forEach((a, i) => {
    const li = document.createElement("li");
    li.className = "action-item" + (i === actionHi ? " active" : "");
    const name = document.createElement("span");
    name.className = "action-name";
    name.textContent = a.id;
    const desc = document.createElement("span");
    desc.className = "action-desc";
    desc.textContent = a.description;
    li.append(name, desc);
    // mousedown (not click) so the input doesn't blur-close before we run.
    li.addEventListener("mousedown", (e) => { e.preventDefault(); runAction(a); });
    actionList.appendChild(li);
  });
}

function moveActionHighlight(delta) {
  if (!actionFiltered.length) return;
  actionHi = (actionHi + delta + actionFiltered.length) % actionFiltered.length;
  [...actionList.children].forEach((li, i) => li.classList.toggle("active", i === actionHi));
}

function runAction(a) {
  closeActions();
  if (a && a.run) a.run();
}

// ---- Cards ----

function cardMessage(c) {
  return { type: "card", op: "upsert", card: { id: c.id, nx: c.nx, ny: c.ny, text: c.text } };
}

function broadcastCard(c) {
  if (c && session) session.broadcast(cardMessage(c));
}

function createCardAtMe() {
  const center = localCenter();
  const card = {
    id: "c" + Math.random().toString(36).slice(2, 9),
    nx: clamp01(center.x / stage.clientWidth),
    ny: clamp01(center.y / stage.clientHeight),
    text: "",
  };
  upsertCard(card, true);
  broadcastCard(cards.get(card.id));
}

// Create or update a card from data (local or from a peer). focus=true puts the
// caret in it (used when you create one yourself).
function upsertCard(data, focus) {
  const id = String(data.id || "");
  if (!id) return;
  const nx = clamp01(Number(data.nx) || 0);
  const ny = clamp01(Number(data.ny) || 0);
  const text = String(data.text == null ? "" : data.text).slice(0, CARD_MAX);

  let card = cards.get(id);
  if (!card) {
    const el = document.createElement("div");
    el.className = "card";
    const ta = document.createElement("textarea");
    ta.className = "card-text";
    ta.maxLength = CARD_MAX;
    ta.placeholder = "Type…";
    ta.addEventListener("input", () => onCardInput(id));
    ta.addEventListener("blur", () => broadcastCard(cards.get(id)));
    el.appendChild(ta);
    cardLayer.appendChild(el);
    card = { id, nx, ny, text, el, ta, sendTimer: null };
    cards.set(id, card);
  }

  card.nx = nx;
  card.ny = ny;
  card.text = text;
  // Don't clobber the editor's caret while it's being edited locally.
  if (document.activeElement !== card.ta && card.ta.value !== text) card.ta.value = text;
  positionCard(card);
  if (focus) card.ta.focus();
}

function onCardInput(id) {
  const card = cards.get(id);
  if (!card) return;
  card.text = card.ta.value.slice(0, CARD_MAX);
  if (card.sendTimer) clearTimeout(card.sendTimer);
  card.sendTimer = setTimeout(() => broadcastCard(card), 300);
}

function positionCard(card) {
  card.el.style.left = card.nx * stage.clientWidth + "px";
  card.el.style.top = card.ny * stage.clientHeight + "px";
}

// ---- Huddle zones ----

function zoneMessage(z) {
  return { type: "zone", op: "upsert", zone: { id: z.id, cx: z.cx, cy: z.cy, r: z.r } };
}

function broadcastZone(z) {
  if (z && session) session.broadcast(zoneMessage(z));
}

function createZoneAtMe() {
  const c = localCenter();
  const zone = {
    id: "z" + Math.random().toString(36).slice(2, 9),
    cx: clamp01(c.x / stage.clientWidth),
    cy: clamp01(c.y / stage.clientHeight),
    r: 0.18,
  };
  upsertZone(zone);
  broadcastZone(zones.get(zone.id));
}

function upsertZone(data) {
  const id = String(data.id || "");
  if (!id) return;
  const cx = clamp01(Number(data.cx) || 0);
  const cy = clamp01(Number(data.cy) || 0);
  const r = Math.min(0.45, Math.max(0.05, Number(data.r) || 0.18));
  let z = zones.get(id);
  if (!z) {
    const el = document.createElement("div");
    el.className = "zone";
    const label = document.createElement("span");
    label.className = "zone-label";
    label.textContent = "huddle";
    el.appendChild(label);
    zoneLayer.appendChild(el);
    z = { id, cx, cy, r, el };
    zones.set(id, z);
  }
  z.cx = cx;
  z.cy = cy;
  z.r = r;
  positionZone(z);
}

function clearZones(broadcast) {
  zones.forEach((z) => z.el.remove());
  zones.clear();
  if (broadcast && session) session.broadcast({ type: "zone", op: "clear" });
}

function positionZone(z) {
  const W = stage.clientWidth;
  const H = stage.clientHeight;
  const rad = z.r * Math.min(W, H);
  z.el.style.left = z.cx * W + "px";
  z.el.style.top = z.cy * H + "px";
  z.el.style.width = z.el.style.height = 2 * rad + "px";
}

// Which zone (if any) contains a pixel point (an avatar centre).
function zoneContaining(pt) {
  const W = stage.clientWidth;
  const H = stage.clientHeight;
  const ref = Math.min(W, H);
  for (const z of zones.values()) {
    if (Math.hypot(pt.x - z.cx * W, pt.y - z.cy * H) <= z.r * ref) return z;
  }
  return null;
}

// Target gain for a peer: zone rules take precedence over distance.
function peerTargetGain(id, myZone) {
  const pn = remotePositions.get(id);
  if (!pn) return 1;
  if (zones.size) {
    const theirZone = zoneContaining(remoteCenter(id));
    if (myZone || theirZone) return myZone && myZone === theirZone ? 1 : ZONE_MUFFLED;
  }
  const me = localNorm();
  return gainForDistance(Math.hypot(me.nx - pn.nx, me.ny - pn.ny));
}

// ---- Dev console ----

function appendConsoleLog(line) {
  const div = document.createElement("div");
  div.className = "ln";
  div.textContent = line;
  dcLog.appendChild(div);
  while (dcLog.childElementCount > LOG_LIMIT) dcLog.removeChild(dcLog.firstChild);
  dcLog.scrollTop = dcLog.scrollHeight;
}

function renderConsolePeers() {
  dcPeers.textContent = "";
  if (peerStatuses.size === 0) {
    const empty = document.createElement("div");
    empty.className = "pstatus";
    empty.textContent = "(none)";
    dcPeers.appendChild(empty);
    return;
  }
  for (const [id, status] of peerStatuses) {
    const row = document.createElement("div");
    row.className = "dc-peer";
    row.dataset.status = status;
    const dot = document.createElement("span");
    dot.className = "pdot";
    const pid = document.createElement("span");
    pid.className = "pid";
    pid.textContent = displayName(id);
    const st = document.createElement("span");
    st.className = "pstatus";
    st.textContent = status;
    row.append(dot, pid, st);
    dcPeers.appendChild(row);
  }
}

// Keep the local tile inside the stage when the window is resized, and
// re-project remote tiles from their normalized positions to new pixel coords.
function onResize() {
  if (selfTile.hidden) return;
  clampPosition();
  applyPosition();
  remoteTiles.forEach((_, id) => applyRemotePosition(id));
  cards.forEach(positionCard);
  zones.forEach(positionZone);
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

function toggleBodies() {
  const on = stage.classList.toggle("bodies-on");
  toggleBodyBtn.textContent = on ? "Hide bodies" : "Show bodies";
}

// ---- Face auto-framing ----

function loadFaceFramePref() {
  try {
    return localStorage.getItem("funmeets-faceframe") !== "off";
  } catch (_) {
    return true;
  }
}

function updateFrameBtn() {
  toggleFrameBtn.textContent = "Auto-frame: " + (faceFrameOn ? "On" : "Off");
  toggleFrameBtn.classList.toggle("active", faceFrameOn);
}

function toggleFaceFrame() {
  faceFrameOn = !faceFrameOn;
  if (faceFramer) faceFramer.setEnabled(faceFrameOn);
  try { localStorage.setItem("funmeets-faceframe", faceFrameOn ? "on" : "off"); } catch (_) {}
  updateFrameBtn();
}

// ---- Spatial audio ----

function loadSpatialPref() {
  try {
    return localStorage.getItem("funmeets-spatial") !== "off";
  } catch (_) {
    return true;
  }
}

function updateSpatialBtn() {
  toggleSpatialBtn.textContent = "Spatial audio: " + (spatialOn ? "On" : "Off");
  toggleSpatialBtn.classList.toggle("active", spatialOn);
}

function toggleSpatial() {
  spatialOn = !spatialOn;
  spatialAudio.setEnabled(spatialOn);
  try { localStorage.setItem("funmeets-spatial", spatialOn ? "on" : "off"); } catch (_) {}
  updateSpatialBtn();
}

// Throw the selected emoji from your avatar toward where you click the stage.
function onStageClick(e) {
  if (!running) return;
  if (e.target.closest("#sidebar, #topbar, #controls, #overlay, #actions, .card, button, input, textarea, a")) return;
  const rect = stage.getBoundingClientRect();
  throwEmoji(e.clientX - rect.left, e.clientY - rect.top);
}

// Give the local tile its avatar and turn bodies on by default.
applyAvatar(selfTile, avatarConfig);
buildAvatarUI();
buildEmojiUI();
buildBgUI();
stage.classList.add("bodies-on");

// Load the remembered (or a random) name and pre-fill the join screen.
username = loadUsername();
usernameInput.value = username;

startBtn.addEventListener("click", start);
usernameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); start(); }
});
copyLinkBtn.addEventListener("click", copyInviteLink);
toggleBodyBtn.addEventListener("click", toggleBodies);
toggleFrameBtn.addEventListener("click", toggleFaceFrame);
toggleSpatialBtn.addEventListener("click", toggleSpatial);
spatialAudio.setEnabled(spatialOn);
updateSpatialBtn();
chatForm.addEventListener("submit", sendChat);
chatInput.addEventListener("focus", resetHeld);
bgUrl.addEventListener("focus", resetHeld);
chatToggleBtn.addEventListener("click", toggleChat);
consoleToggleBtn.addEventListener("click", toggleConsole);
avatarToggleBtn.addEventListener("click", toggleAvatar);
emojiToggleBtn.addEventListener("click", toggleEmojiPanel);
trailToggleBtn.addEventListener("click", toggleTrail);
bgToggleBtn.addEventListener("click", toggleBgPanel);
bgUrlApply.addEventListener("click", applyImageUrl);
bgUrl.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); applyImageUrl(); } });
bgFile.addEventListener("change", onBgFile);
bgReset.addEventListener("click", () => setBackground(""));
stage.addEventListener("click", onStageClick);

// Actions menu input
actionQueryInput.addEventListener("input", () => renderActions(actionQueryInput.value));
actionQueryInput.addEventListener("keydown", (e) => {
  // stopPropagation so the window keydown handler doesn't also act on these
  // (e.g. Enter would otherwise focus the chat box after the menu closes).
  if (e.key === "ArrowDown") { moveActionHighlight(1); e.preventDefault(); e.stopPropagation(); }
  else if (e.key === "ArrowUp") { moveActionHighlight(-1); e.preventDefault(); e.stopPropagation(); }
  else if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); if (actionFiltered[actionHi]) runAction(actionFiltered[actionHi]); }
  else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeActions(); }
});
actionQueryInput.addEventListener("blur", () => closeActions());
renderConsolePeers(); // show "(none)" until peers connect
window.addEventListener("keydown", onKeyDown);
window.addEventListener("keyup", onKeyUp);
window.addEventListener("resize", onResize);
window.addEventListener("beforeunload", () => {
  if (session) session.leave();
  if (faceFramer) faceFramer.stop();
});
