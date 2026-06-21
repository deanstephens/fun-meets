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
  normalizeAvatar, applyAvatar, SHOULDER_CENTER, SHOULDER_SX, SHOULDER_SY,
  UPPER_ARM, ELBOW_REST,
} from "./avatar.js";
import { AVATAR_POSITIONS } from "./avatar-positions.js";
import { EMOJIS, spawnShower, spawnThrow, spawnTrail } from "./emoji.js";
import {
  COLOR_PRESETS, PATTERN_PRESETS, imageCss, sanitizeBg, downscaleImage,
} from "./background.js";
import { createFaceFramer } from "./faceframe.js";
import { createSpatialAudio, gainForDistance } from "./spatialaudio.js";
import { createVoiceActivity } from "./voiceactivity.js";

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
const toastEl = document.getElementById("toast");
const toastEmoji = toastEl.querySelector(".toast-emoji");
const toastText = toastEl.querySelector(".toast-text");
const timerEl = document.getElementById("timer");
const timerEmoji = timerEl.querySelector(".timer-emoji");
const timerText = timerEl.querySelector(".timer-text");
const pollCreateEl = document.getElementById("poll-create");
const pollQuestionInput = document.getElementById("poll-question");
const pollOptInputs = [...document.querySelectorAll(".poll-opt-input")];
const pollSubmitBtn = document.getElementById("poll-submit");
const pollCancelBtn = document.getElementById("poll-cancel");
const pollEl = document.getElementById("poll");
const pollQEl = document.getElementById("poll-q");
const pollOptionsEl = document.getElementById("poll-options");
const pollTotalEl = document.getElementById("poll-total");
const pollEndBtn = document.getElementById("poll-end");
const toggleBodyBtn = document.getElementById("toggle-body");
const toggleFrameBtn = document.getElementById("toggle-frame");
const toggleSpatialBtn = document.getElementById("toggle-spatial");
const toggleCollisionBtn = document.getElementById("toggle-collision");
const statusInput = document.getElementById("status-input");
const selfStatusEl = document.getElementById("self-status");
const toggleScreenBtn = document.getElementById("toggle-screen");
const screenLayer = document.getElementById("screen-layer");
const sidebar = document.getElementById("sidebar");
const chatForm = document.getElementById("chat");
const chatInput = document.getElementById("chat-input");
const chatPanel = document.getElementById("chatpanel");
const chatLog = document.getElementById("chat-log");
const chatToggleBtn = document.getElementById("chat-toggle");
const chatUnreadEl = document.getElementById("chat-unread");

// Settings panel (room/AV toggles)
const settingsSection = document.getElementById("settingspanel");
const settingsToggleBtn = document.getElementById("settings-toggle");

// Avatar customisation elements
const avatarSection = document.getElementById("avatarpanel");
const avatarToggleBtn = document.getElementById("avatar-toggle");
const avatarList = document.getElementById("avatar-list");

// Actions / cards / zones elements
const zoneLayer = document.getElementById("zone-layer");
const cardLayer = document.getElementById("card-layer");
const ballEl = document.getElementById("ball");
const gameLayer = document.getElementById("game-layer");
const drawCanvas = document.getElementById("draw-layer");
const drawCtx = drawCanvas.getContext("2d");
const drawTools = document.getElementById("draw-tools");
const drawColorsEl = document.getElementById("draw-colors");
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

// id -> presence status text for each remote participant.
const remotePresence = new Map();
let presence = ""; // our own status ("" = available); persisted across reloads

// Our own display name (persisted across reloads). Initialised in the setup
// section below, once the name word-lists are defined.
let username = "";

// Our own avatar configuration (persisted across reloads).
const avatarConfig = loadAvatar();

// Emoji state: the currently-selected emoji (for throw/trail) and trail on/off.
const emojiState = loadEmoji();
let lastTrail = 0;
const TRAIL_INTERVAL = 130; // ms between trail drops while moving

// Cards dropped on the shared board:
//   id -> { id, nx, ny, text, color, author, el, ta, authorEl, sendTimer }
const cards = new Map();
const CARD_MAX = 500;
// Sticky-note colours (key -> background). Keys are what's synced.
const CARD_COLORS = ["yellow", "pink", "green", "blue", "purple"];
const CARD_BG = {
  yellow: "#fff3b0", pink: "#ffc6d9", green: "#c4f0c5", blue: "#bfe3ff", purple: "#e3cffb",
};
let cardDrag = null; // in-progress card drag state

// One-shot avatar emotes (name -> animation duration ms). Played locally and
// broadcast so everyone sees them; rate-limited on send and receive.
const EMOTES = { wave: 1300, jump: 900, dance: 1800 };
const EMOTE_COOLDOWN = 700;
let lastEmoteAt = 0;
const peerEmoteAt = new Map(); // peerId -> last emote time (receive throttle)
let heldCardId = null; // card our avatar is carrying (toggle with E)
const CARRY_SIDE_OFFSET = 0.36; // held card offset to the facing side (×tile size)
const CARRY_HAND_OFFSET = 0.52; // held card offset below the head (~hand height)

// Huddle/breakout zones: id -> { id, cx, cy, r, el }. People in the same zone
// hear each other clearly; everyone else is muffled.
const zones = new Map();
const ZONE_MUFFLED = 0.08;

// The room's current background CSS ("" = the stylesheet default). Shared.
// The host is authoritative: it (re)sends the room background to new joiners,
// so a newcomer's default doesn't clobber what the room already chose.
let currentBg = "";
let amHost = false;
let myMeshId = ""; // our mesh peer id (used to key our poll vote)

// Avatar collision (room-wide, host-controlled). When on, your avatar can't
// overlap others — you bounce off. Enforced locally against received positions;
// the on/off state is broadcast by the host. See [[#61]].
let collisionOn = false;
let bounceVx = 0; // rebound velocity (px/s), decays each frame
let bounceVy = 0;
let wasColliding = false; // were we touching someone last frame (for impact bounce)
const COLLISION_FACTOR = 0.9; // min centre distance = factor × tile size (heads ≈ tile)
const BOUNCE_GAIN = 0.6; // how much incoming speed becomes rebound on impact
const BOUNCE_DECAY = 7; // per-second exponential decay of the rebound

// Serverless board persistence: the shared board (background + cards + zones) is
// snapshotted to localStorage so a room survives everyone leaving. The host
// restores it on return; nobody saves until the host/guest role has settled, so
// the initial empty board never clobbers a saved one.
let roomName = "";
let boardSettled = false;
let boardReady = false;
let boardSaveTimer = null;

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

// Voice-activity detection -> "talking" ring on the speaker's tile.
const voiceActivity = createVoiceActivity();
window.__voiceActivity = voiceActivity; // debug/inspection handle

// Screen sharing: our outgoing screen stream + a panel per shared screen.
let screenStream = null;
const screens = new Map(); // id ("self" or peerId) -> { el, video }

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
  reconnecting: "reconnecting…",
  failed: "couldn’t connect",
  connected: "",
};

async function start() {
  errorEl.hidden = true;
  startBtn.disabled = true;
  startBtn.textContent = "Requesting camera…";

  // Start the audio contexts now, inside this click gesture — iOS Safari won't
  // let an AudioContext run if it's first created later (when a peer's stream
  // arrives), which would otherwise leave peers silent on iPad/iPhone.
  spatialAudio.resume();
  voiceActivity.resume();

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
    voiceActivity.addStream("self", localStream); // talking indicator for us
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
  roomName = room;
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
      if (s.myId) { dcMyId.textContent = s.myId; myMeshId = s.myId; }
      if (typeof s.isHost === "boolean") {
        const becameHost = s.isHost && !amHost;
        amHost = s.isHost;
        dcRole.textContent = s.isHost ? "host" : "guest";
        updateCollisionBtn(); // show/hide the host-only control
        // A newly elected host re-asserts the room-wide collision state so it
        // survives the host change.
        if (becameHost && session) session.broadcast({ type: "collision", on: collisionOn });
        // Once the mesh says our role is *settled* (host elected, or guest
        // bootstrapped): the host restores the saved board (it starts alone); a
        // guest takes the live board from the host instead. Only now do we allow
        // saving, so the empty start state can't overwrite a saved board. (A
        // guest later re-elected as host keeps its live state — boardSettled is
        // already true, so it won't wrongly restore from stale storage.)
        if (s.roleSettled && !boardSettled) {
          boardSettled = true;
          if (s.isHost) restoreSavedBoard();
          boardReady = true;
        }
      }
      if (s.error) {
        console.warn("[mesh] status error:", s.error);
        appendConsoleLog("status error: " + s.error);
      }
    },
    onPeerStream: (id, stream) => addRemoteStream(id, stream),
    onScreenStream: (id, stream) => renderScreen(id, stream, displayName(id), false),
    onScreenStop: (id) => removeScreen(id),
    onPeerLeft: (id) => {
      removeRemoteTile(id);
      peerStatuses.delete(id);
      remoteNames.delete(id);
      remotePresence.delete(id);
      // The host frees a departed player's game seats so the game stays playable.
      if (amHost) games.forEach((g) => {
        let changed = false;
        if (g.seats.X === id) { g.seats.X = null; changed = true; }
        if (g.seats.O === id) { g.seats.O = null; changed = true; }
        if (changed) { renderGame(g); broadcastGame(g); }
      });
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
      session.sendTo(id, presenceMessage());
      // Only the host hands out shared board state (background + cards), so a
      // newcomer's empty state doesn't overwrite it.
      if (amHost) {
        session.sendTo(id, { type: "background", css: currentBg });
        cards.forEach((c) => session.sendTo(id, cardMessage(c)));
        zones.forEach((z) => session.sendTo(id, zoneMessage(z)));
        const rem = timerRemaining();
        if (rem > 0) session.sendTo(id, { type: "timer", op: "start", remaining: rem });
        session.sendTo(id, { type: "collision", on: collisionOn });
        if (strokes.size) session.sendTo(id, { type: "draw", op: "sync", strokes: [...strokes.values()] });
        if (ball) session.sendTo(id, { type: "ball", op: "state", nx: ball.nx, ny: ball.ny, vx: ball.vx, vy: ball.vy });
        if (tagIt) session.sendTo(id, { type: "tag", op: "set", it: tagIt });
        games.forEach((g) => session.sendTo(id, gameMessage(g)));
        if (poll) session.sendTo(id, {
          type: "poll", op: "sync",
          poll: { id: poll.id, question: poll.question, options: poll.options },
          votes: [...poll.votes],
        });
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
        if (tile) tile.el.classList.toggle("holding", !!data.holding); // gripping a card
        if (moved) markRemoteWalking(id); // animate their body while moving
      } else if (data.type === "chat" && typeof data.text === "string") {
        const text = data.text.slice(0, 200);
        const tile = ensureRemoteTile(id);
        showBubble(tile.el, text);
        addChatMessage(displayName(id), text, false);
      } else if (data.type === "name") {
        remoteNames.set(id, sanitizeName(data.name) || shortId(id));
        applyRemoteName(id);
      } else if (data.type === "status") {
        remotePresence.set(id, sanitizeStatus(data.status));
        applyRemotePresence(id);
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
      } else if (data.type === "roll") {
        showRoll(data); // shared dice roll / random pick
      } else if (data.type === "timer") {
        if (data.op === "start" && data.remaining > 0 && data.remaining <= 7200) setTimer(data.remaining, false);
        else if (data.op === "clear") stopTimer(false);
      } else if (data.type === "poll") {
        handlePollMessage(data);
      } else if (data.type === "collision") {
        setCollision(data.on); // room-wide setting from the host
      } else if (data.type === "draw") {
        handleDrawMessage(data); // shared whiteboard strokes
      } else if (data.type === "ball") {
        handleBallMessage(data); // kickable shared ball
      } else if (data.type === "tag") {
        handleTagMessage(data); // tag minigame state
      } else if (data.type === "game") {
        handleGameMessage(data); // board games (tic-tac-toe / connect-four)
      } else if (data.type === "emote") {
        const name = typeof data.name === "string" ? data.name : "";
        if (!EMOTES[name]) return; // unknown emote — ignore
        const now = Date.now();
        if (now - (peerEmoteAt.get(id) || 0) < EMOTE_COOLDOWN) return; // throttle
        peerEmoteAt.set(id, now);
        showEmote(ensureRemoteTile(id).el, name);
      } else if (data.type === "background") {
        applyBackground(sanitizeBg(data.css));
      } else if (data.type === "card" && data.op === "upsert" && data.card) {
        upsertCard(data.card, false);
      } else if (data.type === "card" && data.op === "delete" && data.id) {
        deleteCard(String(data.id), false);
      } else if (data.type === "zone") {
        if (data.op === "upsert" && data.zone) upsertZone(data.zone);
        else if (data.op === "clear") clearZones(false);
      } else if (data.type === "screen" && data.op === "stop") {
        removeScreen(id);
      }
    },
  });
  window.__mesh = session; // debug/inspection handle

  if (CALIBRATE) initCalibration();
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
  if (tile && tile.nameEl) tile.nameEl.textContent = displayName(id);
  renderConsolePeers();
}

// ---- Presence status ----

function sanitizeStatus(s) {
  if (typeof s !== "string") return "";
  return s.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 40);
}

function loadPresence() {
  try { return sanitizeStatus(localStorage.getItem("funmeets-status")); } catch (_) { return ""; }
}

function savePresence() {
  try { localStorage.setItem("funmeets-status", presence); } catch (_) {}
}

function presenceMessage() {
  return { type: "status", status: presence };
}

// Show a status string in a tile's two-line label (hides the line when empty).
function renderStatus(el, text) {
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("empty", !text);
}

function setPresence(text) {
  presence = sanitizeStatus(text);
  statusInput.value = presence;
  renderStatus(selfStatusEl, presence);
  savePresence();
  if (session) session.broadcast(presenceMessage());
}

function applyRemotePresence(id) {
  const tile = remoteTiles.get(id);
  if (tile) renderStatus(tile.status, remotePresence.get(id) || "");
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
  return { type: "pos", nx: n.nx, ny: n.ny, holding: !!heldCardId };
}

function broadcastPosition() {
  if (session) session.broadcast(posMessage());
}

function applyRemotePosition(id) {
  const tile = remoteTiles.get(id);
  const p = remotePositions.get(id);
  if (!tile || !p) return;
  const { mx, my } = movableArea();
  tile.el.style.translate = `${p.nx * mx}px ${p.ny * my}px`;
}

// Fallback layout for a tile we haven't received a position for yet.
function placeRemote(el) {
  const size = tileSize();
  const gap = 16;
  const cols = Math.max(1, Math.floor((stage.clientWidth - gap) / (size + gap)));
  const idx = remoteSlot++;
  const x = gap + (idx % cols) * (size + gap);
  const y = gap + Math.floor(idx / cols) * (size + gap);
  el.style.translate = `${x}px ${y}px`;
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
  const nameEl = document.createElement("span");
  nameEl.className = "tile-name";
  nameEl.textContent = displayName(id);
  const statusEl = document.createElement("span");
  statusEl.className = "tile-status empty";
  label.append(nameEl, statusEl);

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

  tile = { el, head, video, veil, label, nameEl, status: statusEl };
  remoteTiles.set(id, tile);
  renderStatus(statusEl, remotePresence.get(id) || "");

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
  // Re-add cleanly: on a reconnect this is a fresh stream for an existing peer,
  // and addPeer/addStream no-op if the id is still registered.
  spatialAudio.removePeer(id);
  voiceActivity.removeStream(id);
  // Route the audio through spatial audio (distance-based volume).
  spatialAudio.addPeer(id, stream, tile.video);
  // Watch it for voice activity (talking ring).
  voiceActivity.addStream(id, stream);
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
  voiceActivity.removeStream(id);
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
  // Position via the `translate` property so `transform` stays free for one-shot
  // emote animations (jump etc.).
  selfTile.style.translate = `${pos.x}px ${pos.y}px`;
}

// Push our avatar out of any overlap with other avatars (heads ≈ the tile
// circle), and on first contact convert our incoming speed into a rebound so we
// bounce off rather than stick. Run only when collision is enabled.
function resolveCollisions(vx, vy) {
  const ts = tileSize();
  const minDist = ts * COLLISION_FACTOR;
  let cx = pos.x + ts / 2;
  let cy = pos.y + ts / 2;
  let hit = false;
  let bx = 0, by = 0; // rebound normal accumulated across contacts
  remoteTiles.forEach((_, id) => {
    const r = remoteCenter(id);
    const ddx = cx - r.x;
    const ddy = cy - r.y;
    const d = Math.hypot(ddx, ddy);
    if (d >= minDist) return;
    hit = true;
    const nx = d < 0.001 ? 1 : ddx / d;
    const ny = d < 0.001 ? 0 : ddy / d;
    cx += nx * (minDist - d); // resolve the overlap along the contact normal
    cy += ny * (minDist - d);
    const vIn = -(vx * nx + vy * ny); // our speed heading into them
    if (vIn > 0) { bx += nx * vIn; by += ny * vIn; }
  });
  pos.x = cx - ts / 2;
  pos.y = cy - ts / 2;
  clampPosition();
  // Kick only on the first frame of contact, so holding into someone is a solid
  // wall (no per-frame jitter) but a fresh bump springs you back.
  if (hit && !wasColliding) {
    const cap = SPEED * 1.5;
    bounceVx = Math.max(-cap, Math.min(cap, bounceVx + bx * BOUNCE_GAIN));
    bounceVy = Math.max(-cap, Math.min(cap, bounceVy + by * BOUNCE_GAIN));
  }
  wasColliding = hit;
}

// ---- Collision toggle (room-wide, host-controlled) ----

function updateCollisionBtn() {
  toggleCollisionBtn.hidden = !amHost; // guests don't see the control
  toggleCollisionBtn.textContent = "Collision: " + (collisionOn ? "On" : "Off");
  toggleCollisionBtn.classList.toggle("active", collisionOn);
}

// Apply an incoming/known collision state (no broadcast).
function setCollision(on) {
  collisionOn = !!on;
  if (!collisionOn) { bounceVx = bounceVy = 0; wasColliding = false; }
  updateCollisionBtn();
}

// Host toggles it for the whole room.
function toggleCollision() {
  if (!amHost) return;
  setCollision(!collisionOn);
  if (session) session.broadcast({ type: "collision", on: collisionOn });
}

function loop(timestamp) {
  if (lastFrame === null) lastFrame = timestamp;
  const dt = Math.min((timestamp - lastFrame) / 1000, 0.05); // cap large gaps
  lastFrame = timestamp;

  const dx = (held.right ? 1 : 0) - (held.left ? 1 : 0);
  const dy = (held.down ? 1 : 0) - (held.up ? 1 : 0);
  const pressing = dx !== 0 || dy !== 0;

  // Animate our own stick-figure body while moving.
  selfTile.classList.toggle("walking", pressing);

  // Face the direction of horizontal movement (keep facing when moving purely
  // vertically or standing still).
  if (dx > 0) selfTile.classList.remove("facing-left");
  else if (dx < 0) selfTile.classList.add("facing-left");

  // Input velocity (normalized so diagonals aren't faster).
  let vx = 0, vy = 0;
  if (pressing) {
    const len = Math.hypot(dx, dy);
    vx = (dx / len) * SPEED;
    vy = (dy / len) * SPEED;
  }

  // Apply input + any rebound velocity, then resolve collisions. Position can
  // change without a key held (rebound, or being shoved by someone), so we test
  // actual movement rather than just key state.
  const prevX = pos.x, prevY = pos.y;
  pos.x += (vx + bounceVx) * dt;
  pos.y += (vy + bounceVy) * dt;
  clampPosition();
  if (collisionOn) resolveCollisions(vx, vy);
  const decay = Math.exp(-BOUNCE_DECAY * dt);
  bounceVx *= decay;
  bounceVy *= decay;
  if (Math.abs(bounceVx) < 1) bounceVx = 0;
  if (Math.abs(bounceVy) < 1) bounceVy = 0;

  const movedNow = Math.abs(pos.x - prevX) > 0.01 || Math.abs(pos.y - prevY) > 0.01;

  if (movedNow) {
    applyPosition();
    if (heldCardId) carryCardToMe(); // a held card travels with us
    // Throttle position updates to peers while moving.
    if (timestamp - lastPosSent >= POS_INTERVAL) {
      broadcastPosition();
      if (heldCardId) broadcastCard(cards.get(heldCardId));
      lastPosSent = timestamp;
    }
    // Drop an emoji trail behind us if it's enabled (follows the input dir).
    if (pressing && emojiState.trail && timestamp - lastTrail >= TRAIL_INTERVAL) {
      lastTrail = timestamp;
      const c = localCenter();
      const len = Math.hypot(dx, dy) || 1;
      spawnTrail(emojiLayer, emojiState.selected, c.x - (dx / len) * 26, c.y - (dy / len) * 26);
      if (session) session.broadcast({ type: "emoji", action: "trail", emoji: emojiState.selected });
    }
    wasMoving = true;
  } else if (wasMoving) {
    // Send one final update so peers see the exact resting position.
    if (heldCardId) carryCardToMe();
    broadcastPosition();
    if (heldCardId) broadcastCard(cards.get(heldCardId));
    wasMoving = false;
  }

  // Advance the shared ball (host simulates, everyone renders).
  stepBall(dt, timestamp);

  // Tag minigame: host checks for tags; everyone refreshes the "it" indicator.
  stepTag(timestamp);

  // Which huddle zone we're in (highlight it), then update spatial-audio
  // volumes from positions + zone membership. Cheap; runs every frame so it
  // tracks our movement and peers' movement.
  const myZone = zones.size ? zoneContaining(localCenter()) : null;
  if (zones.size) zones.forEach((z) => z.el.classList.toggle("mine", z === myZone));
  spatialAudio.update((id) => peerTargetGain(id, myZone));

  // Voice activity -> "talking" ring on whoever is speaking.
  voiceActivity.poll(timestamp);
  selfTile.classList.toggle("talking", voiceActivity.isSpeaking("self"));
  remoteTiles.forEach((tile, id) => tile.el.classList.toggle("talking", voiceActivity.isSpeaking(id)));

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
  // Escape leaves whiteboard draw mode.
  if (e.key === "Escape" && drawMode) {
    exitDraw();
    e.preventDefault();
    return;
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
  // E picks up the nearest card (or drops the one you're holding).
  if ((e.key === "e" || e.key === "E") && running) {
    toggleCarry();
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

function toggleSettings() {
  const collapsed = !settingsSection.classList.contains("collapsed");
  settingsSection.classList.toggle("collapsed", collapsed);
  settingsToggleBtn.textContent = collapsed ? "Show" : "Hide";
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

// ---- Avatar calibration mode (dev only; ?calibrate=1) ----

const CALIBRATE = new URLSearchParams(window.location.search).has("calibrate");

function initCalibration() {
  const panel = document.getElementById("calibrate");
  const slotsEl = document.getElementById("cal-slots");
  const optionEl = document.getElementById("cal-option");
  const xIn = document.getElementById("cal-x");
  const yIn = document.getElementById("cal-y");
  const sIn = document.getElementById("cal-s");
  const xVal = document.getElementById("cal-x-val");
  const yVal = document.getElementById("cal-y-val");
  const sVal = document.getElementById("cal-s-val");
  const shouldersEl = document.getElementById("cal-shoulders");
  const sxIn = document.getElementById("cal-sx");
  const syIn = document.getElementById("cal-sy");
  const sxVal = document.getElementById("cal-sx-val");
  const syVal = document.getElementById("cal-sy-val");
  const uaIn = document.getElementById("cal-ua");
  const elbowIn = document.getElementById("cal-elbow");
  const uaVal = document.getElementById("cal-ua-val");
  const elbowVal = document.getElementById("cal-elbow-val");

  const SLOTS = Object.keys(AVATAR_OPTIONS);
  // Working copy seeded from the committed adjustments.
  const data = { hat: {}, body: {}, legs: {}, feet: {} };
  for (const slot of SLOTS) {
    const src = AVATAR_POSITIONS[slot] || {};
    for (const opt of Object.keys(src)) data[slot][opt] = { x: 0, y: 0, scale: 1, ...src[opt] };
  }
  const opts = {};
  for (const slot of SLOTS) opts[slot] = AVATAR_OPTIONS[slot].filter((o) => o !== "none");

  let curSlot = "hat";
  let curIdx = 0;
  const curOption = () => opts[curSlot][curIdx];

  function adj() {
    const o = curOption();
    if (!data[curSlot][o]) data[curSlot][o] = { x: 0, y: 0, scale: 1 };
    return data[curSlot][o];
  }

  function partEls() {
    if (curSlot === "hat") return selfTile.querySelectorAll(":scope > .hat-img");
    if (curSlot === "body") return selfTile.querySelectorAll(".figure .torso .cloth");
    if (curSlot === "legs") return selfTile.querySelectorAll(".figure .leg .cloth");
    return selfTile.querySelectorAll(".figure .foot");
  }

  function applyVars() {
    const a = adj();
    partEls().forEach((el) => {
      el.style.setProperty("--ax", a.x + "px");
      el.style.setProperty("--ay", a.y + "px");
      el.style.setProperty("--as", String(a.scale));
    });
  }

  // Arm rig (shoulder pivots + elbow) — body slot only.
  function shoulders() {
    const a = adj();
    if (a.sx == null) a.sx = SHOULDER_SX;
    if (a.sy == null) a.sy = SHOULDER_SY;
    if (a.ua == null) a.ua = UPPER_ARM;
    if (a.elbow == null) a.elbow = ELBOW_REST;
    return a;
  }

  function applyShoulderVars() {
    const fig = selfTile.querySelector(".figure");
    if (!fig) return;
    const a = shoulders();
    fig.style.setProperty("--sh-lx", SHOULDER_CENTER - a.sx + "px");
    fig.style.setProperty("--sh-rx", SHOULDER_CENTER + a.sx + "px");
    fig.style.setProperty("--sh-y", a.sy + "px");
    fig.style.setProperty("--upperarm", a.ua + "px");
    fig.style.setProperty("--elbow", a.elbow + "deg");
  }

  function syncLabels() {
    xVal.textContent = xIn.value;
    yVal.textContent = yIn.value;
    sVal.textContent = Number(sIn.value).toFixed(2);
    sxVal.textContent = sxIn.value;
    syVal.textContent = syIn.value;
    uaVal.textContent = uaIn.value;
    elbowVal.textContent = elbowIn.value;
  }

  function showOutfit() {
    const cfg = normalizeAvatar({});
    cfg[curSlot] = curOption();
    applyAvatar(selfTile, cfg); // preview just this part on a bare figure
    optionEl.textContent = OPTION_LABELS[curOption()] || curOption();
    const a = adj();
    xIn.value = a.x;
    yIn.value = a.y;
    sIn.value = a.scale;
    // Shoulder controls apply to tops only.
    shouldersEl.hidden = curSlot !== "body";
    if (curSlot === "body") {
      const s = shoulders();
      sxIn.value = s.sx;
      syIn.value = s.sy;
      uaIn.value = s.ua;
      elbowIn.value = s.elbow;
      applyShoulderVars();
    }
    syncLabels();
    applyVars();
  }

  function onSlide() {
    const a = adj();
    a.x = Number(xIn.value);
    a.y = Number(yIn.value);
    a.scale = Number(sIn.value);
    syncLabels();
    applyVars();
  }

  function onSlideShoulder() {
    const a = adj();
    a.sx = Number(sxIn.value);
    a.sy = Number(syIn.value);
    a.ua = Number(uaIn.value);
    a.elbow = Number(elbowIn.value);
    syncLabels();
    applyShoulderVars();
  }

  function selectSlot(slot) {
    curSlot = slot;
    curIdx = 0;
    [...slotsEl.children].forEach((b) => b.classList.toggle("active", b.dataset.slot === slot));
    showOutfit();
  }

  function exportJson() {
    const out = {};
    for (const slot of SLOTS) {
      for (const o of Object.keys(data[slot])) {
        const a = data[slot][o];
        const x = a.x || 0;
        const y = a.y || 0;
        const scale = a.scale == null ? 1 : a.scale;
        const entry = {};
        if (x !== 0 || y !== 0 || scale !== 1) Object.assign(entry, { x, y, scale });
        if (slot === "body") {
          if (a.sx != null && a.sx !== SHOULDER_SX) entry.sx = a.sx;
          if (a.sy != null && a.sy !== SHOULDER_SY) entry.sy = a.sy;
          if (a.ua != null && a.ua !== UPPER_ARM) entry.ua = a.ua;
          if (a.elbow != null && a.elbow !== ELBOW_REST) entry.elbow = a.elbow;
        }
        if (Object.keys(entry).length) (out[slot] = out[slot] || {})[o] = entry;
      }
    }
    const json = JSON.stringify(out, null, 2);
    try { navigator.clipboard.writeText(json).catch(() => {}); } catch (_) {}
    const blob = new Blob([json], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "avatar-positions.json";
    link.click();
    URL.revokeObjectURL(link.href);
  }

  SLOTS.forEach((slot) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "opt";
    b.dataset.slot = slot;
    b.textContent = SLOT_LABELS[slot];
    b.addEventListener("click", () => selectSlot(slot));
    slotsEl.appendChild(b);
  });
  document.getElementById("cal-prev").addEventListener("click", () => {
    curIdx = (curIdx - 1 + opts[curSlot].length) % opts[curSlot].length;
    showOutfit();
  });
  document.getElementById("cal-next").addEventListener("click", () => {
    curIdx = (curIdx + 1) % opts[curSlot].length;
    showOutfit();
  });
  [xIn, yIn, sIn].forEach((el) => el.addEventListener("input", onSlide));
  [sxIn, syIn, uaIn, elbowIn].forEach((el) => el.addEventListener("input", onSlideShoulder));
  document.getElementById("cal-export").addEventListener("click", exportJson);

  panel.hidden = false;
  selectSlot("hat");
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
  const m = tile && /([-\d.]+)px\s+([-\d.]+)px/.exec(tile.el.style.translate || "");
  if (m) return { x: parseFloat(m[1]) + ts / 2, y: parseFloat(m[2]) + ts / 2 };
  return { x: stage.clientWidth / 2, y: stage.clientHeight / 2 };
}

// ---- Dice / random picker (a shared, transient result) ----

const DICE_FACES = ["⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];
let lastRollAt = 0;
let toastTimer = null;

function showToast(emoji, text) {
  toastEmoji.textContent = emoji;
  toastText.textContent = text;
  toastEl.classList.remove("show");
  void toastEl.offsetWidth; // restart the fade
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 4200);
}

// Connected participants (us + remote peers) by display name.
function participantNames() {
  const names = [username];
  remoteTiles.forEach((_, id) => names.push(displayName(id)));
  return names;
}

// The roller computes the single result and broadcasts it, so everyone shows
// the same outcome (no divergent per-client randomness).
function rollDice() {
  if (Date.now() - lastRollAt < 800) return;
  lastRollAt = Date.now();
  announceRoll({ kind: "dice", value: 1 + Math.floor(Math.random() * 6), by: username });
}

function pickSomeone() {
  if (Date.now() - lastRollAt < 800) return;
  lastRollAt = Date.now();
  const names = participantNames();
  announceRoll({ kind: "pick", who: names[Math.floor(Math.random() * names.length)], by: username });
}

function announceRoll(data) {
  showRoll(data); // show locally (broadcast doesn't echo to us)
  if (session) session.broadcast({ type: "roll", ...data });
}

function showRoll(data) {
  const by = sanitizeName(data.by) || "Someone";
  if (data.kind === "dice" && data.value >= 1 && data.value <= 6) {
    showToast(DICE_FACES[data.value - 1], `${by} rolled a ${data.value}`);
  } else if (data.kind === "pick" && data.who) {
    showToast("🎯", `${by} picked ${sanitizeName(data.who) || "someone"}`);
  }
}

// ---- Shared countdown timer ----
// We broadcast the *remaining seconds* (not an absolute time), so each client
// counts down on its own clock — no cross-peer clock-sync needed.

let timerEndsAt = 0; // local ms when the active timer ends (0 = none)
let timerTick = null;
let timerHide = null;

function startTimer(seconds) {
  setTimer(seconds, true);
}

function setTimer(seconds, broadcast) {
  if (!(seconds > 0)) return;
  clearTimeout(timerHide);
  timerEndsAt = Date.now() + seconds * 1000;
  timerEl.classList.remove("done");
  timerEmoji.textContent = "⏱";
  timerEl.hidden = false;
  if (broadcast && session) session.broadcast({ type: "timer", op: "start", remaining: seconds });
  tickTimer();
}

function stopTimer(broadcast) {
  timerEndsAt = 0;
  clearTimeout(timerTick);
  clearTimeout(timerHide);
  timerEl.hidden = true;
  timerEl.classList.remove("done");
  if (broadcast && session) session.broadcast({ type: "timer", op: "clear" });
}

function tickTimer() {
  clearTimeout(timerTick);
  if (!timerEndsAt) return;
  const remMs = timerEndsAt - Date.now();
  if (remMs <= 0) { timerEndsAt = 0; timerFinished(); return; }
  const total = Math.ceil(remMs / 1000);
  timerText.textContent = `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
  timerTick = setTimeout(tickTimer, Math.min(250, remMs));
}

function timerFinished() {
  timerEmoji.textContent = "⏰";
  timerText.textContent = "Time's up!";
  timerEl.classList.add("done");
  playBeep();
  clearTimeout(timerHide);
  timerHide = setTimeout(() => { timerEl.hidden = true; timerEl.classList.remove("done"); }, 5000);
}

// Seconds remaining on our active timer (for handing to late joiners), or 0.
function timerRemaining() {
  return timerEndsAt ? Math.ceil((timerEndsAt - Date.now()) / 1000) : 0;
}

// A short two-tone chime when the timer ends (best-effort; may be blocked).
let beepCtx = null;
function playBeep() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!beepCtx) beepCtx = new AC();
    if (beepCtx.state === "suspended") beepCtx.resume();
    const t0 = beepCtx.currentTime;
    [[660, 0], [880, 0.2]].forEach(([freq, off]) => {
      const o = beepCtx.createOscillator();
      const g = beepCtx.createGain();
      o.type = "sine";
      o.frequency.value = freq;
      o.connect(g).connect(beepCtx.destination);
      g.gain.setValueAtTime(0.0001, t0 + off);
      g.gain.exponentialRampToValueAtTime(0.18, t0 + off + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + off + 0.18);
      o.start(t0 + off);
      o.stop(t0 + off + 0.2);
    });
  } catch (_) {}
}

// ---- Polls (shared question + live tally) ----

let poll = null; // { id, question, options:[str], votes: Map<voterId, optionIndex> }

function openPollCreate() {
  pollQuestionInput.value = "";
  pollOptInputs.forEach((i) => (i.value = ""));
  pollCreateEl.hidden = false;
  pollQuestionInput.focus();
}

function closePollCreate() {
  pollCreateEl.hidden = true;
}

function submitPoll() {
  const question = pollQuestionInput.value.trim().slice(0, 120);
  const options = pollOptInputs.map((i) => i.value.trim().slice(0, 60)).filter(Boolean);
  if (!question || options.length < 2) return; // need a question + at least 2 options
  closePollCreate();
  createPoll(question, options.slice(0, 6));
}

function createPoll(question, options) {
  poll = { id: "p" + Math.random().toString(36).slice(2, 9), question, options, votes: new Map() };
  renderPoll();
  if (session) session.broadcast({ type: "poll", op: "create", poll: { id: poll.id, question, options } });
}

function votePoll(i) {
  if (!poll || i < 0 || i >= poll.options.length) return;
  poll.votes.set(myMeshId, i); // one vote each (re-voting moves it)
  renderPoll();
  if (session) session.broadcast({ type: "poll", op: "vote", id: poll.id, option: i, voter: myMeshId });
}

function closePoll(broadcast) {
  const id = poll && poll.id;
  poll = null;
  pollEl.hidden = true;
  if (broadcast && id && session) session.broadcast({ type: "poll", op: "close", id });
}

function renderPoll() {
  if (!poll) { pollEl.hidden = true; return; }
  pollEl.hidden = false;
  pollQEl.textContent = poll.question;
  const counts = poll.options.map(() => 0);
  poll.votes.forEach((opt) => { if (opt >= 0 && opt < counts.length) counts[opt]++; });
  const total = poll.votes.size;
  const mine = poll.votes.get(myMeshId);
  pollOptionsEl.innerHTML = "";
  poll.options.forEach((text, i) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "poll-option" + (mine === i ? " mine" : "");
    const bar = document.createElement("div");
    bar.className = "poll-bar";
    bar.style.width = (total ? Math.round((counts[i] / total) * 100) : 0) + "%";
    const label = document.createElement("span");
    label.className = "poll-label";
    label.textContent = text;
    const count = document.createElement("span");
    count.className = "poll-count";
    count.textContent = total ? `${counts[i]} · ${Math.round((counts[i] / total) * 100)}%` : "0";
    row.append(bar, label, count);
    row.addEventListener("click", () => votePoll(i));
    pollOptionsEl.appendChild(row);
  });
  pollTotalEl.textContent = total === 1 ? "1 vote" : `${total} votes`;
}

// Build/replace the active poll from a (possibly untrusted) message.
function setPollFromData(p, votes) {
  const question = String(p.question == null ? "" : p.question).slice(0, 120);
  const options = Array.isArray(p.options)
    ? p.options.slice(0, 6).map((o) => String(o).slice(0, 60)).filter(Boolean) : [];
  if (!question || options.length < 2) return;
  poll = { id: String(p.id || ""), question, options, votes: new Map() };
  (Array.isArray(votes) ? votes : []).forEach((v) => {
    if (Array.isArray(v) && v[1] >= 0 && v[1] < options.length) poll.votes.set(String(v[0]), v[1]);
  });
  renderPoll();
}

function handlePollMessage(data) {
  if (data.op === "create" && data.poll) {
    setPollFromData(data.poll, []);
  } else if (data.op === "sync" && data.poll) {
    setPollFromData(data.poll, data.votes);
  } else if (data.op === "vote" && poll && data.id === poll.id) {
    if (data.option >= 0 && data.option < poll.options.length && data.voter) {
      poll.votes.set(String(data.voter), data.option);
      renderPoll();
    }
  } else if (data.op === "close" && poll && data.id === poll.id) {
    closePoll(false);
  }
}

// ---- Tag minigame (host-authoritative) ----
// One player is "it"; when their avatar touches another, "it" transfers. The
// host owns the state and detects tags from the synced avatar positions.

let tagIt = null; // mesh id of the "it" player, or null when no game
let tagCooldownUntil = 0; // host: pause tagging just after a transfer
const TAG_COOLDOWN = 1200; // ms grace so you don't instantly tag back
const TAG_DIST_FACTOR = 0.95; // ×tile size; > collision min-distance so tag works with collision on

function updateTagIndicators() {
  selfTile.classList.toggle("it", !!tagIt && tagIt === myMeshId);
  remoteTiles.forEach((tile, id) => tile.el.classList.toggle("it", tagIt === id));
}

function setTagIt(id, broadcast) {
  tagIt = id || null;
  updateTagIndicators();
  if (broadcast && session) session.broadcast({ type: "tag", op: "set", it: tagIt });
}

function startTag() {
  setTagIt(myMeshId, true); // you start the game as "it"
}

function stopTag(broadcast) {
  tagIt = null;
  updateTagIndicators();
  if (broadcast && session) session.broadcast({ type: "tag", op: "stop" });
}

function handleTagMessage(data) {
  if (data.op === "set") {
    tagIt = typeof data.it === "string" ? data.it : null;
    updateTagIndicators();
  } else if (data.op === "stop") {
    stopTag(false);
  }
}

// Host: if the "it" avatar touches another, transfer "it" to them.
function stepTag(timestamp) {
  updateTagIndicators(); // cheap; keeps new/left tiles in sync
  if (!amHost || !tagIt || timestamp < tagCooldownUntil) return;
  const itCenter = tagIt === myMeshId ? localCenter()
    : (remoteTiles.has(tagIt) ? remoteCenter(tagIt) : null);
  if (!itCenter) { setTagIt(myMeshId, true); return; } // the "it" player left — take it over
  const dist = tileSize() * TAG_DIST_FACTOR;
  const others = [];
  if (tagIt !== myMeshId) others.push({ id: myMeshId, c: localCenter() });
  remoteTiles.forEach((_, id) => { if (id !== tagIt) others.push({ id, c: remoteCenter(id) }); });
  for (const o of others) {
    if (Math.hypot(itCenter.x - o.c.x, itCenter.y - o.c.y) < dist) {
      setTagIt(o.id, true);
      tagCooldownUntil = timestamp + TAG_COOLDOWN;
      break;
    }
  }
}

// ---- Kickable ball (host-authoritative physics) ----
// The host integrates position + velocity, bounces the ball off walls and
// avatars, and broadcasts state; guests dead-reckon (integrate + friction)
// between updates and snap to each authoritative state. Coords are normalized.

let ball = null; // { nx, ny, vx, vy }  pos normalized, velocity normalized/sec
let lastBallSent = 0;
let ballWasMoving = false;
const BALL_RADIUS = 22; // px
const BALL_FRICTION = 1.25; // per-second exponential velocity decay
const BALL_WALL_BOUNCE = 0.7; // energy kept on a wall bounce
const BALL_KICK = 540; // px/s imparted when an avatar touches the ball
const BALL_STOP = 12; // px/s below which it stops
const BALL_INTERVAL = 70; // ms between host state broadcasts

function avatarCenters() {
  const list = [localCenter()];
  remoteTiles.forEach((_, id) => list.push(remoteCenter(id)));
  return list;
}

function positionBall() {
  if (!ball) return;
  ballEl.style.left = ball.nx * 100 + "%";
  ballEl.style.top = ball.ny * 100 + "%";
}

// Advance the ball one frame. The host is authoritative (walls, avatar
// collisions, broadcast); everyone integrates + applies friction for smoothness.
function stepBall(dt, timestamp) {
  if (!ball) return;
  const W = stage.clientWidth, H = stage.clientHeight;
  let x = ball.nx * W, y = ball.ny * H;
  let vx = ball.vx * W, vy = ball.vy * H; // px/s
  x += vx * dt;
  y += vy * dt;
  const decay = Math.exp(-BALL_FRICTION * dt);
  vx *= decay;
  vy *= decay;
  if (amHost) {
    const r = BALL_RADIUS;
    if (x < r) { x = r; vx = Math.abs(vx) * BALL_WALL_BOUNCE; }
    else if (x > W - r) { x = W - r; vx = -Math.abs(vx) * BALL_WALL_BOUNCE; }
    if (y < r) { y = r; vy = Math.abs(vy) * BALL_WALL_BOUNCE; }
    else if (y > H - r) { y = H - r; vy = -Math.abs(vy) * BALL_WALL_BOUNCE; }
    const ar = tileSize() * 0.45;
    avatarCenters().forEach((c) => {
      const dx = x - c.x, dy = y - c.y;
      const d = Math.hypot(dx, dy);
      const minD = r + ar;
      if (d < minD && d > 0.01) {
        const ux = dx / d, uy = dy / d;
        x = c.x + ux * minD; // push the ball clear of the avatar
        y = c.y + uy * minD;
        const sp = Math.max(BALL_KICK, Math.hypot(vx, vy)); // kick it away
        vx = ux * sp;
        vy = uy * sp;
      }
    });
    if (Math.hypot(vx, vy) < BALL_STOP) { vx = 0; vy = 0; }
  }
  ball.nx = clamp01(x / W);
  ball.ny = clamp01(y / H);
  ball.vx = vx / W;
  ball.vy = vy / H;
  positionBall();
  if (amHost) {
    const moving = vx !== 0 || vy !== 0;
    if (moving || ballWasMoving) {
      if (timestamp - lastBallSent >= BALL_INTERVAL || (!moving && ballWasMoving)) {
        lastBallSent = timestamp;
        if (session) session.broadcast({ type: "ball", op: "state", nx: ball.nx, ny: ball.ny, vx: ball.vx, vy: ball.vy });
      }
      ballWasMoving = moving;
    }
  }
}

function spawnBall(nx, ny, broadcast) {
  ball = { nx: clamp01(nx), ny: clamp01(ny), vx: 0, vy: 0 };
  ballEl.hidden = false;
  positionBall();
  if (broadcast && session) session.broadcast({ type: "ball", op: "spawn", nx: ball.nx, ny: ball.ny });
}

function spawnBallAction() {
  spawnBall(0.5, 0.5, true); // spawn / reset at the centre, at rest
}

function removeBall(broadcast) {
  ball = null;
  ballEl.hidden = true;
  if (broadcast && session) session.broadcast({ type: "ball", op: "remove" });
}

function handleBallMessage(data) {
  if (data.op === "spawn") {
    spawnBall(+data.nx || 0.5, +data.ny || 0.5, false);
  } else if (data.op === "state") {
    if (!ball) { ball = { nx: 0.5, ny: 0.5, vx: 0, vy: 0 }; ballEl.hidden = false; }
    ball.nx = clamp01(+data.nx || 0);
    ball.ny = clamp01(+data.ny || 0);
    ball.vx = +data.vx || 0;
    ball.vy = +data.vy || 0;
    positionBall();
  } else if (data.op === "remove") {
    removeBall(false);
  }
}

// ---- Whiteboard (shared freehand drawing) ----
// Strokes are stored as vector data (normalized points) so they redraw on
// resize and can be handed to late joiners; rendered onto a canvas layer.

const DRAW_COLORS = ["#1b1b1f", "#e5484d", "#f5a524", "#46d27f", "#5b8def", "#f4f4f8"];
const DRAW_WIDTH = 3;
const strokes = new Map(); // id -> { id, color, w, pts: [[nx,ny],...] }
const myStrokeIds = []; // our strokes, in order, for undo
let drawMode = false;
let drawColor = DRAW_COLORS[0];
let curStroke = null;

function sizeDrawCanvas() {
  const w = stage.clientWidth, h = stage.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  drawCanvas.width = Math.round(w * dpr);
  drawCanvas.height = Math.round(h * dpr);
  drawCanvas.style.width = w + "px";
  drawCanvas.style.height = h + "px";
  drawCtx.setTransform(dpr, 0, 0, dpr, 0, 0); // draw in CSS pixels
  redrawStrokes();
}

function paintStroke(s) {
  const w = stage.clientWidth, h = stage.clientHeight;
  if (!s.pts.length) return;
  drawCtx.strokeStyle = s.color;
  drawCtx.fillStyle = s.color;
  drawCtx.lineWidth = s.w;
  drawCtx.lineCap = "round";
  drawCtx.lineJoin = "round";
  if (s.pts.length === 1) {
    drawCtx.beginPath();
    drawCtx.arc(s.pts[0][0] * w, s.pts[0][1] * h, s.w / 2, 0, Math.PI * 2);
    drawCtx.fill();
    return;
  }
  drawCtx.beginPath();
  drawCtx.moveTo(s.pts[0][0] * w, s.pts[0][1] * h);
  for (let i = 1; i < s.pts.length; i++) drawCtx.lineTo(s.pts[i][0] * w, s.pts[i][1] * h);
  drawCtx.stroke();
}

function redrawStrokes() {
  drawCtx.clearRect(0, 0, stage.clientWidth, stage.clientHeight);
  strokes.forEach(paintStroke);
}

function drawPoint(e) {
  const r = stage.getBoundingClientRect();
  return [clamp01((e.clientX - r.left) / stage.clientWidth), clamp01((e.clientY - r.top) / stage.clientHeight)];
}

function onDrawDown(e) {
  if (!drawMode || !running) return;
  e.preventDefault();
  try { drawCanvas.setPointerCapture(e.pointerId); } catch (_) {}
  curStroke = { id: "k" + Math.random().toString(36).slice(2, 9), color: drawColor, w: DRAW_WIDTH, pts: [drawPoint(e)] };
}

function onDrawMove(e) {
  if (!curStroke) return;
  const p = drawPoint(e);
  const last = curStroke.pts[curStroke.pts.length - 1];
  if (Math.hypot(p[0] - last[0], p[1] - last[1]) < 0.003) return; // thin out points
  curStroke.pts.push(p);
  const w = stage.clientWidth, h = stage.clientHeight;
  drawCtx.strokeStyle = curStroke.color;
  drawCtx.lineWidth = curStroke.w;
  drawCtx.lineCap = "round";
  drawCtx.lineJoin = "round";
  drawCtx.beginPath();
  drawCtx.moveTo(last[0] * w, last[1] * h);
  drawCtx.lineTo(p[0] * w, p[1] * h);
  drawCtx.stroke();
}

function onDrawUp() {
  if (!curStroke) return;
  const s = curStroke;
  curStroke = null;
  if (s.pts.length === 1) paintStroke(s); // a tap = a dot
  strokes.set(s.id, s);
  myStrokeIds.push(s.id);
  if (session) session.broadcast({ type: "draw", op: "stroke", stroke: s });
}

function undoDraw() {
  let id = null;
  while (myStrokeIds.length) { const c = myStrokeIds.pop(); if (strokes.has(c)) { id = c; break; } }
  if (!id) return;
  strokes.delete(id);
  redrawStrokes();
  if (session) session.broadcast({ type: "draw", op: "remove", id });
}

function clearDraw(broadcast) {
  strokes.clear();
  myStrokeIds.length = 0;
  redrawStrokes();
  if (broadcast && session) session.broadcast({ type: "draw", op: "clear" });
}

function sanitizeStroke(st) {
  if (!st || !Array.isArray(st.pts) || !st.pts.length) return null;
  const pts = st.pts.slice(0, 4000).map((p) => [clamp01(+p[0] || 0), clamp01(+p[1] || 0)]);
  const color = typeof st.color === "string" && /^#[0-9a-fA-F]{3,8}$/.test(st.color) ? st.color : DRAW_COLORS[0];
  const w = Math.min(20, Math.max(1, +st.w || DRAW_WIDTH));
  return { id: String(st.id || "k" + Math.random().toString(36).slice(2, 9)), color, w, pts };
}

function handleDrawMessage(data) {
  if (data.op === "stroke" && data.stroke) {
    const s = sanitizeStroke(data.stroke);
    if (s) { strokes.set(s.id, s); paintStroke(s); }
  } else if (data.op === "remove" && data.id) {
    if (strokes.delete(String(data.id))) redrawStrokes();
  } else if (data.op === "clear") {
    clearDraw(false);
  } else if (data.op === "sync" && Array.isArray(data.strokes)) {
    data.strokes.forEach((st) => { const s = sanitizeStroke(st); if (s) strokes.set(s.id, s); });
    redrawStrokes();
  }
}

function buildDrawUI() {
  DRAW_COLORS.forEach((c) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "draw-swatch";
    b.dataset.color = c;
    b.style.background = c;
    b.setAttribute("aria-label", "Pen colour");
    b.addEventListener("click", () => { drawColor = c; updateDrawSwatches(); });
    drawColorsEl.appendChild(b);
  });
  updateDrawSwatches();
}

function updateDrawSwatches() {
  [...drawColorsEl.children].forEach((b) => b.classList.toggle("active", b.dataset.color === drawColor));
}

function enterDraw() {
  drawMode = true;
  stage.classList.add("drawing");
  drawTools.hidden = false;
  updateDrawSwatches();
}

function exitDraw() {
  drawMode = false;
  curStroke = null;
  stage.classList.remove("drawing");
  drawTools.hidden = true;
}

function toggleDraw() {
  if (drawMode) exitDraw(); else enterDraw();
}

// ---- Emotes (one-shot avatar animations) ----

function playEmote(name) {
  if (!EMOTES[name]) return;
  const now = Date.now();
  if (now - lastEmoteAt < EMOTE_COOLDOWN) return; // rate-limit
  lastEmoteAt = now;
  showEmote(selfTile, name);
  if (session) session.broadcast({ type: "emote", name });
}

function showEmote(tileEl, name) {
  const dur = EMOTES[name];
  if (!dur) return;
  // Clear any in-flight emote and reflow so the animation restarts cleanly.
  Object.keys(EMOTES).forEach((n) => tileEl.classList.remove("emote-" + n));
  void tileEl.offsetWidth;
  tileEl.classList.add("emote-" + name);
  clearTimeout(tileEl.__emoteTimer);
  tileEl.__emoteTimer = setTimeout(() => tileEl.classList.remove("emote-" + name), dur);
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
  saveBoard();
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
    id: "wave",
    label: "Wave",
    description: "Wave hello — everyone sees your avatar do it",
    run: () => playEmote("wave"),
  },
  {
    id: "jump",
    label: "Jump",
    description: "Hop up and down",
    run: () => playEmote("jump"),
  },
  {
    id: "dance",
    label: "Dance",
    description: "Bust a little move",
    run: () => playEmote("dance"),
  },
  {
    id: "roll-dice",
    label: "Roll a die",
    description: "Roll a 6-sided die — everyone sees the same result",
    run: rollDice,
  },
  {
    id: "pick-someone",
    label: "Pick someone",
    description: "Randomly pick a participant — who's next?",
    run: pickSomeone,
  },
  {
    id: "timer-1",
    label: "Timer: 1 min",
    description: "Start a shared 1-minute countdown",
    run: () => startTimer(60),
  },
  {
    id: "timer-2",
    label: "Timer: 2 min",
    description: "Start a shared 2-minute countdown",
    run: () => startTimer(120),
  },
  {
    id: "timer-5",
    label: "Timer: 5 min",
    description: "Start a shared 5-minute countdown",
    run: () => startTimer(300),
  },
  {
    id: "stop-timer",
    label: "Stop timer",
    description: "Clear the shared countdown",
    run: () => stopTimer(true),
  },
  {
    id: "create-poll",
    label: "Create poll",
    description: "Ask a question with options — everyone votes",
    run: openPollCreate,
  },
  {
    id: "close-poll",
    label: "Close poll",
    description: "End the active poll",
    run: () => closePoll(true),
  },
  {
    id: "whiteboard",
    label: "Whiteboard",
    description: "Draw freehand on the shared board",
    run: toggleDraw,
  },
  {
    id: "spawn-ball",
    label: "Ball: spawn / reset",
    description: "Drop a kickable ball in the middle (or reset it there)",
    run: spawnBallAction,
  },
  {
    id: "remove-ball",
    label: "Ball: remove",
    description: "Remove the kickable ball",
    run: () => removeBall(true),
  },
  {
    id: "start-tag",
    label: "Tag: start (you're it)",
    description: "Start a game of tag — touch someone to pass it on",
    run: startTag,
  },
  {
    id: "stop-tag",
    label: "Tag: stop",
    description: "End the tag game",
    run: () => stopTag(true),
  },
  {
    id: "create-card",
    label: "Create card",
    description: "Drop an editable card where you're standing",
    run: createCardAtMe,
  },
  {
    id: "tic-tac-toe",
    label: "Tic-tac-toe",
    description: "Drop a tic-tac-toe board to play together",
    run: () => createGameAtMe("ttt"),
  },
  {
    id: "connect-four",
    label: "Connect four",
    description: "Drop a connect-four board to play together",
    run: () => createGameAtMe("c4"),
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
  {
    id: "save-board",
    label: "Save board to file",
    description: "Download a snapshot of the background, cards and zones",
    run: exportBoard,
  },
  {
    id: "load-board",
    label: "Load board from file",
    description: "Restore a board snapshot from a file (shared with everyone)",
    run: importBoard,
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

// ---- Board persistence (serverless: localStorage + file snapshot) ----

function boardKey() {
  return "funmeets-board-" + roomName;
}

function snapshotBoard() {
  return {
    v: 1,
    bg: currentBg,
    cards: [...cards.values()].map((c) => ({ id: c.id, nx: c.nx, ny: c.ny, text: c.text, color: c.color, author: c.author })),
    zones: [...zones.values()].map((z) => ({ id: z.id, cx: z.cx, cy: z.cy, r: z.r })),
  };
}

// Debounced save of the current board to localStorage (per room).
function saveBoard() {
  if (!roomName || !boardReady) return;
  if (boardSaveTimer) clearTimeout(boardSaveTimer);
  boardSaveTimer = setTimeout(() => {
    try { localStorage.setItem(boardKey(), JSON.stringify(snapshotBoard())); } catch (_) {}
  }, 400);
}

// Apply a board snapshot (from storage or a file). When broadcast is true the
// pieces are pushed to peers too (used for an imported file).
function applySnapshot(snap, broadcast) {
  if (!snap || typeof snap !== "object") return;
  if (typeof snap.bg === "string") {
    applyBackground(snap.bg);
    if (broadcast && session) session.broadcast({ type: "background", css: currentBg });
  }
  if (Array.isArray(snap.cards)) {
    snap.cards.forEach((c) => {
      upsertCard(c);
      if (broadcast) broadcastCard(cards.get(String(c.id)));
    });
  }
  if (Array.isArray(snap.zones)) {
    snap.zones.forEach((z) => {
      upsertZone(z);
      if (broadcast) broadcastZone(zones.get(String(z.id)));
    });
  }
  saveBoard();
}

// Host-only, called when we (re)claim a room alone: bring the board back.
function restoreSavedBoard() {
  let snap = null;
  try {
    const raw = localStorage.getItem(boardKey());
    if (raw) snap = JSON.parse(raw);
  } catch (_) {}
  if (snap) applySnapshot(snap, false); // we're alone, nobody to broadcast to
}

function exportBoard() {
  const json = JSON.stringify(snapshotBoard(), null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "fun-meets-board-" + (roomName || "room") + ".json";
  link.click();
  URL.revokeObjectURL(link.href);
}

// Hidden file input reused for importing a board snapshot.
const boardFileInput = document.createElement("input");
boardFileInput.type = "file";
boardFileInput.id = "board-file-input";
boardFileInput.accept = "application/json,.json";
boardFileInput.style.display = "none";
boardFileInput.addEventListener("change", () => {
  const file = boardFileInput.files && boardFileInput.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try { applySnapshot(JSON.parse(String(reader.result)), true); } catch (_) {}
    boardFileInput.value = "";
  };
  reader.readAsText(file);
});
document.body.appendChild(boardFileInput);

function importBoard() {
  boardFileInput.click();
}

function cardMessage(c) {
  return {
    type: "card", op: "upsert",
    card: {
      id: c.id, nx: c.nx, ny: c.ny, text: c.text, color: c.color, author: c.author,
      held: c.id === heldCardId,
    },
  };
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
    color: "yellow",
    author: username,
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
  const color = CARD_BG[data.color] ? data.color : "yellow";
  const author = sanitizeName(data.author);

  let card = cards.get(id);
  if (!card) {
    const el = document.createElement("div");
    el.className = "card";

    // Header doubles as a drag handle and holds the author + tools.
    const head = document.createElement("div");
    head.className = "card-head";
    const authorEl = document.createElement("span");
    authorEl.className = "card-author";
    const tools = document.createElement("div");
    tools.className = "card-tools";
    CARD_COLORS.forEach((key) => {
      const dot = document.createElement("button");
      dot.type = "button";
      dot.className = "card-color";
      dot.dataset.color = key;
      dot.style.background = CARD_BG[key];
      dot.title = "Recolour";
      dot.addEventListener("click", () => recolorCard(id, key, true));
      tools.appendChild(dot);
    });
    const del = document.createElement("button");
    del.type = "button";
    del.className = "card-delete";
    del.textContent = "×";
    del.title = "Delete card";
    del.addEventListener("click", () => deleteCard(id, true));
    tools.append(del);
    head.append(authorEl, tools);
    head.addEventListener("pointerdown", (e) => startCardDrag(e, id));

    const ta = document.createElement("textarea");
    ta.className = "card-text";
    ta.maxLength = CARD_MAX;
    ta.placeholder = "Type…";
    ta.addEventListener("input", () => onCardInput(id));
    ta.addEventListener("blur", () => broadcastCard(cards.get(id)));

    el.append(head, ta);
    cardLayer.appendChild(el);
    card = { id, nx, ny, text, color, author, el, ta, authorEl, sendTimer: null };
    cards.set(id, card);
  }

  card.nx = nx;
  card.ny = ny;
  card.text = text;
  card.color = color;
  if (author) card.author = author;
  applyCardColor(card);
  // A card someone is carrying shrinks to "hand size" so the arms show around it
  // (the local carried card sets this in pickUp/drop; this covers remote cards).
  if (id !== heldCardId) card.el.classList.toggle("held", !!data.held);
  card.authorEl.textContent = card.author || "";
  card.authorEl.title = card.author ? "by " + card.author : "";
  // Don't clobber the editor's caret while it's being edited locally.
  if (document.activeElement !== card.ta && card.ta.value !== text) card.ta.value = text;
  positionCard(card);
  if (focus) card.ta.focus();
  saveBoard();
}

function applyCardColor(card) {
  card.el.style.background = CARD_BG[card.color] || CARD_BG.yellow;
  card.el.querySelectorAll(".card-color").forEach((d) => {
    d.classList.toggle("sel", d.dataset.color === card.color);
  });
}

function recolorCard(id, color, broadcast) {
  const card = cards.get(id);
  if (!card || !CARD_BG[color]) return;
  card.color = color;
  applyCardColor(card);
  if (broadcast) broadcastCard(card);
  saveBoard();
}

function deleteCard(id, broadcast) {
  const card = cards.get(id);
  if (!card) return;
  if (heldCardId === id) { heldCardId = null; selfTile.classList.remove("holding"); broadcastPosition(); }
  card.el.remove();
  cards.delete(id);
  if (broadcast && session) session.broadcast({ type: "card", op: "delete", id });
  saveBoard();
}

// ---- Carry a card with your avatar (toggle with E) ----

function toggleCarry() {
  if (heldCardId) { dropCard(); return; }
  const id = nearestCardId();
  if (id) pickUpCard(id);
}

// The nearest card within reach of our avatar, or null.
function nearestCardId() {
  const me = localCenter();
  let best = null;
  let bestD = tileSize() * 1.3; // pick-up radius
  cards.forEach((c) => {
    const d = Math.hypot(me.x - c.nx * stage.clientWidth, me.y - c.ny * stage.clientHeight);
    if (d < bestD) { bestD = d; best = c.id; }
  });
  return best;
}

function pickUpCard(id) {
  if (!cards.has(id)) return;
  heldCardId = id;
  selfTile.classList.add("holding"); // arms grip it (see CSS)
  cards.get(id).el.classList.add("held"); // shrink to hand size
  carryCardToMe();
  broadcastPosition(); // announce the holding state to peers
  broadcastCard(cards.get(id));
  saveBoard();
}

function dropCard() {
  const card = heldCardId && cards.get(heldCardId);
  heldCardId = null;
  selfTile.classList.remove("holding");
  if (card) card.el.classList.remove("held");
  broadcastPosition();
  if (card) { broadcastCard(card); saveBoard(); }
}

// Snap the held card to our hands — out to the side we're facing, at arm height.
function carryCardToMe() {
  const card = heldCardId && cards.get(heldCardId);
  if (!card) { heldCardId = null; selfTile.classList.remove("holding"); return; }
  const me = localCenter();
  const dir = selfTile.classList.contains("facing-left") ? -1 : 1;
  card.nx = clamp01((me.x + dir * tileSize() * CARRY_SIDE_OFFSET) / stage.clientWidth);
  card.ny = clamp01((me.y + tileSize() * CARRY_HAND_OFFSET) / stage.clientHeight);
  positionCard(card);
}

// ---- Card dragging (move) ----

function startCardDrag(e, id) {
  if (e.target.closest("button")) return; // a tool click, not a drag
  const card = cards.get(id);
  if (!card) return;
  e.preventDefault();
  const rect = stage.getBoundingClientRect();
  const cx = card.nx * stage.clientWidth;
  const cy = card.ny * stage.clientHeight;
  cardDrag = { id, offX: e.clientX - rect.left - cx, offY: e.clientY - rect.top - cy, last: 0 };
  card.el.classList.add("dragging");
  window.addEventListener("pointermove", onCardDragMove);
  window.addEventListener("pointerup", onCardDragEnd, { once: true });
}

function onCardDragMove(e) {
  if (!cardDrag) return;
  const card = cards.get(cardDrag.id);
  if (!card) return;
  const rect = stage.getBoundingClientRect();
  card.nx = clamp01((e.clientX - rect.left - cardDrag.offX) / stage.clientWidth);
  card.ny = clamp01((e.clientY - rect.top - cardDrag.offY) / stage.clientHeight);
  positionCard(card);
  const now = e.timeStamp || 0;
  if (now - cardDrag.last > 80) { cardDrag.last = now; broadcastCard(card); }
}

function onCardDragEnd() {
  window.removeEventListener("pointermove", onCardDragMove);
  if (!cardDrag) return;
  const card = cards.get(cardDrag.id);
  cardDrag = null;
  if (card) { card.el.classList.remove("dragging"); broadcastCard(card); saveBoard(); }
}

function onCardInput(id) {
  const card = cards.get(id);
  if (!card) return;
  card.text = card.ta.value.slice(0, CARD_MAX);
  if (card.sendTimer) clearTimeout(card.sendTimer);
  card.sendTimer = setTimeout(() => broadcastCard(card), 300);
  saveBoard();
}

function positionCard(card) {
  card.el.style.left = card.nx * stage.clientWidth + "px";
  card.el.style.top = card.ny * stage.clientHeight + "px";
}

// ---- Board games (tic-tac-toe / connect-four) ----
// A placeable board two people play together. Each move broadcasts the full,
// turn-gated state (turn-based, so there's no concurrent-move conflict); the
// host re-sends every board to late joiners (like cards). Seats are claimed by
// the first two distinct people to play (X first, then O).

const games = new Map(); // id -> { id, type, cells, turn, seats:{X,O}, winner, nx, ny, el, statusEl, gridEl }
const TTT_LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
let gameDrag = null;

const gameCellCount = (type) => (type === "c4" ? 42 : 9);
const gameCols = (type) => (type === "c4" ? 7 : 3);

function createGameAtMe(type) {
  const c = localCenter();
  const g = {
    id: "g" + Math.random().toString(36).slice(2, 9),
    type,
    cells: Array(gameCellCount(type)).fill(""),
    turn: "X",
    seats: { X: null, O: null },
    winner: null,
    nx: clamp01(c.x / stage.clientWidth),
    ny: clamp01(c.y / stage.clientHeight),
  };
  upsertGame(g, true);
  broadcastGame(games.get(g.id));
}

function sanitizeGame(d) {
  if (!d || (d.type !== "ttt" && d.type !== "c4")) return null;
  const n = gameCellCount(d.type);
  const cells = (Array.isArray(d.cells) ? d.cells.slice(0, n) : []).map((v) => (v === "X" || v === "O" ? v : ""));
  while (cells.length < n) cells.push("");
  const seatOf = (v) => (typeof v === "string" && v ? v : null);
  const s = d.seats || {};
  return {
    id: String(d.id || ""),
    type: d.type,
    cells,
    turn: d.turn === "O" ? "O" : "X",
    seats: { X: seatOf(s.X), O: seatOf(s.O) },
    winner: (d.winner === "X" || d.winner === "O" || d.winner === "draw") ? d.winner : null,
    nx: clamp01(Number(d.nx) || 0),
    ny: clamp01(Number(d.ny) || 0),
  };
}

function upsertGame(data, mine) {
  const s = sanitizeGame(data);
  if (!s || !s.id) return;
  let g = games.get(s.id);
  if (!g) {
    g = s;
    games.set(g.id, g);
    buildGameEl(g);
  } else {
    g.cells = s.cells; g.turn = s.turn; g.seats = s.seats; g.winner = s.winner;
    if (!(gameDrag && gameDrag.id === g.id)) { g.nx = s.nx; g.ny = s.ny; }
  }
  positionGame(g);
  renderGame(g);
}

function buildGameEl(g) {
  const el = document.createElement("div");
  el.className = "game";
  el.dataset.type = g.type;
  const head = document.createElement("div");
  head.className = "game-head";
  const status = document.createElement("span");
  status.className = "game-status";
  const reset = document.createElement("button");
  reset.className = "game-btn"; reset.title = "New game"; reset.textContent = "↻";
  reset.addEventListener("click", (e) => { e.stopPropagation(); resetGame(g); });
  const close = document.createElement("button");
  close.className = "game-btn"; close.title = "Remove"; close.textContent = "×";
  close.addEventListener("click", (e) => { e.stopPropagation(); closeGame(g); });
  head.append(status, reset, close);
  head.addEventListener("pointerdown", (e) => startGameDrag(e, g.id));
  const grid = document.createElement("div");
  grid.className = "game-grid";
  el.append(head, grid);
  gameLayer.appendChild(el);
  g.el = el; g.statusEl = status; g.gridEl = grid;
}

// Label for a seat: the player's name if claimed, else the piece (X/O or colour).
function seatLabel(g, seat) {
  const id = g.seats[seat];
  if (id) return id === myMeshId ? "You" : displayName(id);
  return g.type === "c4" ? (seat === "X" ? "Red" : "Yellow") : seat;
}

function renderGame(g) {
  let txt;
  if (g.winner === "draw") txt = "Draw";
  else if (g.winner) txt = g.seats[g.winner] === myMeshId ? "You win! 🎉" : seatLabel(g, g.winner) + " wins";
  else if (g.seats[g.turn] === myMeshId) txt = "Your turn";
  else if (g.seats[g.turn]) txt = seatLabel(g, g.turn) + "’s turn";
  else txt = seatLabel(g, g.turn) + " — tap to play";
  g.statusEl.textContent = (g.type === "c4" ? "Connect Four · " : "Tic-Tac-Toe · ") + txt;

  g.gridEl.style.gridTemplateColumns = `repeat(${gameCols(g.type)}, 1fr)`;
  g.gridEl.innerHTML = "";
  g.cells.forEach((v, i) => {
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "game-cell" + (v ? " " + (v === "X" ? "x" : "o") : "");
    if (g.type === "ttt" && v) cell.textContent = v;
    cell.disabled = !!g.winner;
    const target = g.type === "c4" ? i % 7 : i;
    cell.addEventListener("click", (e) => { e.stopPropagation(); playCell(g, target); });
    g.gridEl.appendChild(cell);
  });
}

function playCell(g, target) {
  if (g.winner) return;
  const seat = g.turn;
  const other = seat === "X" ? "O" : "X";
  if (g.seats[seat] !== myMeshId) {
    // Claim the open seat on your first move; you can't also be the other seat.
    if (g.seats[seat] === null && g.seats[other] !== myMeshId) g.seats[seat] = myMeshId;
    else return;
  }
  if (g.type === "ttt") {
    if (g.cells[target] !== "") return;
    g.cells[target] = seat;
  } else {
    let placed = -1;
    for (let r = 5; r >= 0; r--) { const i = r * 7 + target; if (g.cells[i] === "") { g.cells[i] = seat; placed = i; break; } }
    if (placed === -1) return; // column full
  }
  g.winner = checkGameWin(g);
  if (!g.winner) g.turn = other;
  renderGame(g);
  broadcastGame(g);
}

function checkGameWin(g) {
  const c = g.cells;
  if (g.type === "ttt") {
    for (const [a, b, d] of TTT_LINES) if (c[a] && c[a] === c[b] && c[b] === c[d]) return c[a];
  } else {
    const at = (r, col) => (r >= 0 && r < 6 && col >= 0 && col < 7 ? c[r * 7 + col] : "");
    const dirs = [[0, 1], [1, 0], [1, 1], [1, -1]];
    for (let r = 0; r < 6; r++) for (let col = 0; col < 7; col++) {
      const v = at(r, col);
      if (!v) continue;
      for (const [dr, dc] of dirs) { let k = 1; while (k < 4 && at(r + dr * k, col + dc * k) === v) k++; if (k === 4) return v; }
    }
  }
  return c.every((x) => x) ? "draw" : null;
}

function resetGame(g) {
  g.cells = Array(gameCellCount(g.type)).fill("");
  g.turn = "X";
  g.winner = null;
  renderGame(g);
  broadcastGame(g);
}

function closeGame(g) {
  if (g.el) g.el.remove();
  games.delete(g.id);
  if (session) session.broadcast({ type: "game", op: "close", id: g.id });
}

function gameMessage(g) {
  return { type: "game", op: "upsert", game: { id: g.id, type: g.type, cells: g.cells, turn: g.turn, seats: g.seats, winner: g.winner, nx: g.nx, ny: g.ny } };
}

function broadcastGame(g) {
  if (session && g) session.broadcast(gameMessage(g));
}

function handleGameMessage(data) {
  if (data.op === "upsert" && data.game) upsertGame(data.game, false);
  else if (data.op === "close" && data.id) {
    const g = games.get(String(data.id));
    if (g) { if (g.el) g.el.remove(); games.delete(g.id); }
  }
}

function positionGame(g) {
  if (!g.el) return;
  g.el.style.left = g.nx * stage.clientWidth + "px";
  g.el.style.top = g.ny * stage.clientHeight + "px";
}

function startGameDrag(e, id) {
  if (e.target.closest("button")) return; // a tool click, not a drag
  const g = games.get(id);
  if (!g) return;
  e.preventDefault();
  const rect = stage.getBoundingClientRect();
  gameDrag = { id, offX: e.clientX - rect.left - g.nx * stage.clientWidth, offY: e.clientY - rect.top - g.ny * stage.clientHeight, last: 0 };
  g.el.classList.add("dragging");
  window.addEventListener("pointermove", onGameDragMove);
  window.addEventListener("pointerup", onGameDragEnd, { once: true });
}

function onGameDragMove(e) {
  if (!gameDrag) return;
  const g = games.get(gameDrag.id);
  if (!g) return;
  const rect = stage.getBoundingClientRect();
  g.nx = clamp01((e.clientX - rect.left - gameDrag.offX) / stage.clientWidth);
  g.ny = clamp01((e.clientY - rect.top - gameDrag.offY) / stage.clientHeight);
  positionGame(g);
  const now = e.timeStamp || 0;
  if (now - gameDrag.last > 80) { gameDrag.last = now; broadcastGame(g); }
}

function onGameDragEnd() {
  window.removeEventListener("pointermove", onGameDragMove);
  if (!gameDrag) return;
  const g = games.get(gameDrag.id);
  gameDrag = null;
  if (g) { g.el.classList.remove("dragging"); broadcastGame(g); }
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
  saveBoard();
}

function clearZones(broadcast) {
  zones.forEach((z) => z.el.remove());
  zones.clear();
  if (broadcast && session) session.broadcast({ type: "zone", op: "clear" });
  saveBoard();
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
  if (heldCardId) carryCardToMe(); // keep the held card snapped to our hands
  zones.forEach(positionZone);
  games.forEach(positionGame);
  sizeDrawCanvas();
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

// ---- Screen sharing ----

function renderScreen(id, stream, label, isSelf) {
  let s = screens.get(id);
  if (!s) {
    const el = document.createElement("div");
    el.className = "screen";
    const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    if (isSelf) video.muted = true; // don't echo our own shared audio
    const lbl = document.createElement("div");
    lbl.className = "screen-label";
    lbl.textContent = (label || "Someone") + " is sharing";
    el.append(video, lbl);
    screenLayer.appendChild(el);
    s = { el, video };
    screens.set(id, s);
  }
  s.video.srcObject = stream;
}

function removeScreen(id) {
  const s = screens.get(id);
  if (!s) return;
  try { s.video.srcObject = null; } catch (_) {}
  s.el.remove();
  screens.delete(id);
}

async function startSharing(stream) {
  if (!stream || screenStream) return;
  screenStream = stream;
  renderScreen("self", stream, "You", true); // show our own share
  if (session) session.startScreen(stream);
  // If the user ends the share via the browser's own UI, react to it.
  const track = stream.getVideoTracks()[0];
  if (track) track.addEventListener("ended", stopSharing, { once: true });
  updateScreenBtn();
}

function stopSharing() {
  if (!screenStream) return;
  if (session) {
    session.stopScreen();
    // Tell peers explicitly — PeerJS media close() doesn't reliably reach them.
    session.broadcast({ type: "screen", op: "stop" });
  }
  screenStream.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
  screenStream = null;
  removeScreen("self");
  updateScreenBtn();
}

async function toggleScreen() {
  if (screenStream) { stopSharing(); return; }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    console.warn("[screen] getDisplayMedia not supported");
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    startSharing(stream);
  } catch (_) {
    // user cancelled the picker or permission denied
  }
}

function updateScreenBtn() {
  const sharing = !!screenStream;
  toggleScreenBtn.textContent = sharing ? "Stop sharing" : "Share screen";
  toggleScreenBtn.classList.toggle("active", sharing);
}

// Test hook: start/stop a screen share with a provided stream (bypasses the
// getDisplayMedia picker, which can't run in automated tests).
window.__shareScreen = (stream) => startSharing(stream);
window.__stopScreen = () => stopSharing();
window.__draw = () => strokes.size; // debug: count of whiteboard strokes
window.__ball = () => (ball ? { ...ball } : null); // debug: ball state
window.__tag = () => tagIt; // debug: who is "it"
window.__games = () => [...games.values()].map((g) => ({ id: g.id, type: g.type, cells: g.cells, turn: g.turn, seats: g.seats, winner: g.winner })); // debug
window.__myid = () => myMeshId; // debug: our mesh id

// Throw the selected emoji from your avatar toward where you click the stage.
function onStageClick(e) {
  if (!running || drawMode) return; // in draw mode, clicks are ink, not emoji throws
  if (e.target.closest("#sidebar, #topbar, #controls, #overlay, #actions, #calibrate, .card, .game, button, input, textarea, a")) return;
  const rect = stage.getBoundingClientRect();
  throwEmoji(e.clientX - rect.left, e.clientY - rect.top);
}

// Give the local tile its avatar and turn bodies on by default.
applyAvatar(selfTile, avatarConfig);
buildAvatarUI();
buildEmojiUI();
buildBgUI();
buildDrawUI();
sizeDrawCanvas();
stage.classList.add("bodies-on");

// Load the remembered (or a random) name and pre-fill the join screen.
username = loadUsername();
usernameInput.value = username;

// Restore the saved presence status and show it under our name.
presence = loadPresence();
statusInput.value = presence;
renderStatus(selfStatusEl, presence);

startBtn.addEventListener("click", start);
usernameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); start(); }
});
copyLinkBtn.addEventListener("click", copyInviteLink);
// Poll creation form + results panel.
pollSubmitBtn.addEventListener("click", submitPoll);
pollCancelBtn.addEventListener("click", closePollCreate);
pollEndBtn.addEventListener("click", () => closePoll(true));
[pollQuestionInput, ...pollOptInputs].forEach((inp) => {
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); submitPoll(); }
    else if (e.key === "Escape") { e.preventDefault(); closePollCreate(); }
  });
});
pollCreateEl.addEventListener("click", (e) => { if (e.target === pollCreateEl) closePollCreate(); });
toggleBodyBtn.addEventListener("click", toggleBodies);
toggleFrameBtn.addEventListener("click", toggleFaceFrame);
toggleSpatialBtn.addEventListener("click", toggleSpatial);
toggleCollisionBtn.addEventListener("click", toggleCollision);
// Presence status: set from the input (Enter/blur) or a preset button.
statusInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); setPresence(statusInput.value); statusInput.blur(); }
});
statusInput.addEventListener("change", () => setPresence(statusInput.value));
document.querySelectorAll(".status-presets button").forEach((btn) => {
  btn.addEventListener("click", () => setPresence(btn.dataset.status));
});
// Whiteboard: drawing on the canvas + toolbar.
drawCanvas.addEventListener("pointerdown", onDrawDown);
drawCanvas.addEventListener("pointermove", onDrawMove);
drawCanvas.addEventListener("pointerup", onDrawUp);
drawCanvas.addEventListener("pointercancel", onDrawUp);
document.getElementById("draw-undo").addEventListener("click", undoDraw);
document.getElementById("draw-clear").addEventListener("click", () => clearDraw(true));
document.getElementById("draw-done").addEventListener("click", exitDraw);
toggleScreenBtn.addEventListener("click", toggleScreen);
// Screen capture isn't available on iOS/iPadOS (WebKit has no getDisplayMedia),
// so hide the button there rather than leave a control that does nothing.
if (!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia)) {
  toggleScreenBtn.hidden = true;
}
spatialAudio.setEnabled(spatialOn);
updateSpatialBtn();
chatForm.addEventListener("submit", sendChat);
chatInput.addEventListener("focus", resetHeld);
bgUrl.addEventListener("focus", resetHeld);
chatToggleBtn.addEventListener("click", toggleChat);
consoleToggleBtn.addEventListener("click", toggleConsole);
settingsToggleBtn.addEventListener("click", toggleSettings);
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
// Leave cleanly on unload so peers get our "bye" and drop us promptly. Both
// events fire best-effort (pagehide is more reliable on mobile/Safari); guard
// so we only do it once.
let leftPage = false;
function leavePage() {
  if (leftPage) return;
  leftPage = true;
  if (screenStream) stopSharing();
  if (session) session.leave();
  if (faceFramer) faceFramer.stop();
}
window.addEventListener("beforeunload", leavePage);
window.addEventListener("pagehide", leavePage);
