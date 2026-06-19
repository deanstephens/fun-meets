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
const toggleBodyBtn = document.getElementById("toggle-body");
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

// Emoji elements
const emojiLayer = document.getElementById("emoji-layer");
const emojiSection = document.getElementById("emojipanel");
const emojiToggleBtn = document.getElementById("emoji-toggle");
const emojiPalette = document.getElementById("emoji-palette");
const trailToggleBtn = document.getElementById("trail-toggle");

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

// Our own avatar configuration (persisted across reloads).
const avatarConfig = loadAvatar();

// Emoji state: the currently-selected emoji (for throw/trail) and trail on/off.
const emojiState = loadEmoji();
let lastTrail = 0;
const TRAIL_INTERVAL = 130; // ms between trail drops while moving

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
      if (typeof s.isHost === "boolean") dcRole.textContent = s.isHost ? "host" : "guest";
      if (s.error) {
        console.warn("[mesh] status error:", s.error);
        appendConsoleLog("status error: " + s.error);
      }
    },
    onPeerStream: (id, stream) => addRemoteStream(id, stream),
    onPeerLeft: (id) => {
      removeRemoteTile(id);
      peerStatuses.delete(id);
      renderConsolePeers();
    },
    // Per-peer connection status (connecting / connected / failed).
    onPeerStatus: (id, status) => {
      setRemoteStatus(id, status);
      peerStatuses.set(id, status);
      renderConsolePeers();
    },
    onLog: (line) => appendConsoleLog(line),
    // A peer just connected — send them our current position and look.
    onPeerJoin: (id) => {
      if (!session) return;
      session.sendTo(id, posMessage());
      session.sendTo(id, avatarMessage());
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
        addChatMessage(shortId(id), text, false);
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
  label.textContent = shortId(id);

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

  tile = { el, head, video, veil };
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

  requestAnimationFrame(loop);
}

function isTyping() {
  return document.activeElement === chatInput;
}

// Drop any held movement keys (e.g. when focus moves into the chat box, so the
// avatar doesn't keep gliding because we never see the keyup).
function resetHeld() {
  held.up = held.down = held.left = held.right = false;
  selfTile.classList.remove("walking");
}

function onKeyDown(e) {
  if (isTyping()) {
    if (e.key === "Escape") chatInput.blur();
    return; // let the input field handle the keystroke
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
    pid.textContent = shortId(id);
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

// Throw the selected emoji from your avatar toward where you click the stage.
function onStageClick(e) {
  if (!running) return;
  if (e.target.closest("#sidebar, #topbar, #controls, #overlay, button, input, a")) return;
  const rect = stage.getBoundingClientRect();
  throwEmoji(e.clientX - rect.left, e.clientY - rect.top);
}

// Give the local tile its avatar and turn bodies on by default.
applyAvatar(selfTile, avatarConfig);
buildAvatarUI();
buildEmojiUI();
stage.classList.add("bodies-on");

startBtn.addEventListener("click", start);
copyLinkBtn.addEventListener("click", copyInviteLink);
toggleBodyBtn.addEventListener("click", toggleBodies);
chatForm.addEventListener("submit", sendChat);
chatInput.addEventListener("focus", resetHeld);
chatToggleBtn.addEventListener("click", toggleChat);
consoleToggleBtn.addEventListener("click", toggleConsole);
avatarToggleBtn.addEventListener("click", toggleAvatar);
emojiToggleBtn.addEventListener("click", toggleEmojiPanel);
trailToggleBtn.addEventListener("click", toggleTrail);
stage.addEventListener("click", onStageClick);
renderConsolePeers(); // show "(none)" until peers connect
window.addEventListener("keydown", onKeyDown);
window.addEventListener("keyup", onKeyUp);
window.addEventListener("resize", onResize);
window.addEventListener("beforeunload", () => session && session.leave());
