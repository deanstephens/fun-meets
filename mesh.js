// mesh.js — Serverless N-peer mesh for Fun Meets.
//
// Signaling runs over the PUBLIC PeerJS cloud broker (a service we do not
// operate — consistent with the project's "no server" principle); audio/video
// flows directly peer-to-peer over WebRTC.
//
// Topology: a full mesh. Every participant has a random "mesh" peer id. One
// participant also holds a well-known "introducer" id derived from the room
// name — that participant is the host/entry point. New peers connect to the
// introducer just long enough to learn the roster (everyone's mesh ids), then
// dial each other so every participant ends up directly connected to every
// other. The introducer carries no media; there is no central relay.
//
// Host re-election: because the introducer id is separate from mesh identity,
// when the host leaves the well-known id is freed and the lowest-id survivor
// claims it — becoming the new entry point and state distributor — without any
// peer having to change its identity or re-form its existing connections.
//
// Glare avoidance: for any pair, only the lexicographically-smaller peer id
// initiates the data connection and the media call; the larger id waits and
// answers. When the host introduces a newcomer it dials it directly so the link
// forms regardless of id order.

const Peer = window.Peer || (window.peerjs && window.peerjs.Peer);

const ROOM_PREFIX = "funmeets-v1-";

// Resolve an optional signaling-broker override. By default we use the public
// PeerJS cloud broker. Two ways to point elsewhere (e.g. a private/self-hosted
// PeerJS server on your LAN):
//   * window.__peerServer = { host, port, path, secure }  (set before load)
//   * a `?broker=local` URL param — uses a broker co-located with this page
//     (same host, port 9100, path /myapp), over wss:// when the page is HTTPS.
function brokerOverride() {
  if (typeof window === "undefined") return {};
  if (window.__peerServer) return window.__peerServer;
  try {
    if (new URLSearchParams(window.location.search).get("broker") === "local") {
      return {
        host: window.location.hostname,
        port: 9100,
        path: "/myapp",
        secure: window.location.protocol === "https:",
      };
    }
  } catch (_) {}
  return {};
}

const PEER_OPTS = {
  config: {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
    ],
  },
  ...brokerOverride(),
};

// How long to wait for a dialed peer to connect before declaring it failed.
// Past this with no connection, it's almost always NAT/firewall traversal.
const DIAL_TIMEOUT_MS = 12000;

// The host beats this often so survivors notice it leaving without waiting for
// the (slow) WebRTC ICE timeout; if a guest hears nothing for the timeout, it
// triggers re-election.
const HOST_BEAT_MS = 2500;
const HOST_TIMEOUT_MS = 8000;

export function joinRoom({ room, localStream, onStatus, onPeerStream, onPeerLeft, onPeerJoin, onMessage, onPeerStatus, onLog, onScreenStream, onScreenStop }) {
  const hostId = ROOM_PREFIX + room + "-host";

  const state = {
    peer: null, // our random mesh peer
    myId: null, // our mesh id
    isHost: false, // do we currently hold the introducer?
    roleSettled: false, // have we determined host vs guest yet?
    hostListener: null, // the introducer Peer (only when we're host)
    hostMeshId: null, // the mesh id of whoever currently holds the introducer
    lastHostBeat: 0, // when we last heard the host's heartbeat
    beatTimer: null, // host's heartbeat interval
    livenessTimer: null, // guest's host-liveness check
    reelectTimer: null, // pending claim/bootstrap retry
    connections: new Map(), // peerId -> DataConnection
    connecting: new Set(), // peerIds currently being dialed
    calls: new Map(), // peerId -> MediaConnection (webcam)
    everConnected: new Set(), // peerIds whose media ICE reached connected
    dialTimers: new Map(), // peerId -> dial-timeout handle
    screenStream: null, // our screen-share stream while sharing
    screenCalls: new Map(), // peerId -> outgoing screen MediaConnection
    closed: false,
  };

  const log = (...a) => {
    console.log("[mesh]", ...a);
    if (onLog) {
      onLog(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
    }
  };

  function reportStatus(id, s) {
    if (onPeerStatus) onPeerStatus(id, s);
  }

  function armDialTimeout(id) {
    clearDialTimeout(id);
    state.dialTimers.set(id, setTimeout(() => {
      state.dialTimers.delete(id);
      // Still not connected after the timeout → surface it as failed rather
      // than leaving the user staring at a silent "connecting" forever.
      if (!state.everConnected.has(id) && !state.connections.has(id)) {
        log("dial timeout ->", id);
        reportStatus(id, "failed");
      }
    }, DIAL_TIMEOUT_MS));
  }

  function clearDialTimeout(id) {
    const t = state.dialTimers.get(id);
    if (t) { clearTimeout(t); state.dialTimers.delete(id); }
  }

  function emitStatus(extra) {
    if (!onStatus) return;
    onStatus({
      room,
      myId: state.myId,
      isHost: state.isHost,
      roleSettled: state.roleSettled,
      peerCount: state.connections.size,
      ...extra,
    });
  }

  function knownIds() {
    return [state.myId, ...state.connections.keys()];
  }

  // Decide whether to dial `id`, and do it. Safe to call repeatedly. Only the
  // lower id initiates (glare avoidance); the higher id waits and answers.
  function tryConnect(id) {
    if (state.closed || !id || id === state.myId) return;
    if (state.connections.has(id) || state.connecting.has(id)) return;
    if (state.myId > id) return;
    state.connecting.add(id);
    log("dial ->", id);
    armDialTimeout(id);
    wireData(state.peer.connect(id, { reliable: true }));
  }

  function broadcastRoster() {
    const msg = { type: "roster", peers: knownIds() };
    state.connections.forEach((c) => {
      try { if (c.open) c.send(msg); } catch (_) {}
    });
  }

  function wireData(conn) {
    // The peer now has (or will shortly have) a tile; show it as connecting.
    reportStatus(conn.peer, "connecting");
    conn.on("open", () => {
      state.connecting.delete(conn.peer);
      state.connections.set(conn.peer, conn);
      clearDialTimeout(conn.peer);
      log("data open <->", conn.peer);
      // Tell EVERYONE (including the newcomer) the current roster, so existing
      // peers learn about later joiners — not just whoever connects to them.
      // tryConnect is idempotent and id-ordered, so this never storms.
      broadcastRoster();
      // Lower id places the media call.
      if (state.myId < conn.peer) placeCall(conn.peer);
      // If we're sharing our screen, send it to the newcomer too.
      if (state.screenStream) placeScreenCall(conn.peer);
      emitStatus();
      // Let the app push initial state (e.g. our current position) to the
      // newcomer now that the data channel is open.
      if (onPeerJoin) onPeerJoin(conn.peer);
    });
    conn.on("data", (msg) => {
      if (!msg) return;
      if (msg.type === "roster" && Array.isArray(msg.peers)) {
        msg.peers.forEach((id) => tryConnect(id));
      } else if (msg.type === "host" && msg.id) {
        // The host's announce/heartbeat: who holds the introducer, and proof
        // it's still alive.
        state.hostMeshId = msg.id;
        state.lastHostBeat = Date.now();
      } else if (msg.type === "app") {
        // Application-level payload (position updates, future game state, …).
        if (onMessage) onMessage(conn.peer, msg.data);
      }
    });
    conn.on("close", () => dropPeer(conn.peer));
    conn.on("error", (e) => {
      log("data error", conn.peer, e && e.type);
      state.connecting.delete(conn.peer);
    });
  }

  function placeCall(id) {
    if (state.closed || state.calls.has(id)) return;
    log("call ->", id);
    wireCall(state.peer.call(id, localStream));
  }

  // A second, one-way media call carrying our screen-share stream.
  function placeScreenCall(id) {
    if (state.closed || !state.screenStream || state.screenCalls.has(id)) return;
    log("screen ->", id);
    const call = state.peer.call(id, state.screenStream, { metadata: { kind: "screen" } });
    state.screenCalls.set(id, call);
    call.on("close", () => state.screenCalls.delete(id));
    call.on("error", () => state.screenCalls.delete(id));
  }

  function wireCall(call) {
    state.calls.set(call.peer, call);
    watchIce(call);
    call.on("stream", (remoteStream) => {
      if (onPeerStream) onPeerStream(call.peer, remoteStream);
    });
    call.on("close", () => dropPeer(call.peer));
    call.on("error", (e) => log("call error", call.peer, e && e.type));
  }

  // Watch the media connection's ICE state to (a) report connection status and
  // (b) clean up peers that drop. We distinguish "never connected" (likely a
  // NAT/firewall failure — keep the tile visible as failed) from "was connected
  // then lost" (the peer left/crashed — remove it).
  function watchIce(call) {
    const attach = () => {
      const pc = call.peerConnection;
      if (!pc || pc.__funmeetsWatched) return;
      pc.__funmeetsWatched = true;
      const handle = () => {
        const s = pc.iceConnectionState;
        if (s === "connected" || s === "completed") {
          state.everConnected.add(call.peer);
          clearDialTimeout(call.peer);
          reportStatus(call.peer, "connected");
        } else if (s === "failed" || s === "closed" || s === "disconnected") {
          log("ice", s, "->", call.peer);
          if (state.everConnected.has(call.peer)) {
            dropPeer(call.peer); // it was up and went away → peer left
          } else {
            reportStatus(call.peer, "failed"); // never came up → connection failed
          }
        }
      };
      pc.addEventListener("iceconnectionstatechange", handle);
      handle(); // catch a state that may already be set
    };
    attach();
    call.on("stream", attach); // fallback in case peerConnection wasn't ready yet
  }

  function dropPeer(id) {
    let changed = false;
    if (state.calls.has(id)) {
      try { state.calls.get(id).close(); } catch (_) {}
      state.calls.delete(id);
      changed = true;
    }
    if (state.connections.has(id)) {
      try { state.connections.get(id).close(); } catch (_) {}
      state.connections.delete(id);
      changed = true;
    }
    if (state.screenCalls.has(id)) {
      try { state.screenCalls.get(id).close(); } catch (_) {}
      state.screenCalls.delete(id);
    }
    state.connecting.delete(id);
    state.everConnected.delete(id);
    clearDialTimeout(id);
    if (changed) {
      log("peer left", id);
      if (onPeerLeft) onPeerLeft(id);
      // A peer that left can no longer be sharing a screen to us.
      if (onScreenStop) onScreenStop(id);
      emitStatus();
      // If the host left, the lowest-id survivor takes over the introducer.
      if (id === state.hostMeshId) {
        log("host left -> re-election");
        state.hostMeshId = null;
        maybeReelect(id);
      }
    }
  }

  function wireCommon() {
    state.peer.on("connection", (conn) => wireData(conn));
    state.peer.on("call", (call) => {
      if (call.metadata && call.metadata.kind === "screen") {
        // A one-way screen-share call: answer with no stream, just receive.
        log("answer screen <-", call.peer);
        call.answer();
        call.on("stream", (s) => { if (onScreenStream) onScreenStream(call.peer, s); });
        call.on("close", () => { if (onScreenStop) onScreenStop(call.peer); });
        call.on("error", () => { if (onScreenStop) onScreenStop(call.peer); });
        return;
      }
      log("answer call <-", call.peer);
      call.answer(localStream);
      wireCall(call);
    });
    state.peer.on("disconnected", () => {
      if (state.closed) return;
      log("broker disconnected; reconnecting");
      try { state.peer.reconnect(); } catch (_) {}
    });
    state.peer.on("error", (e) => {
      const type = e && e.type;
      log("peer error", type);
      if (type === "peer-unavailable") {
        const m = /peer (\S+)/.exec(e.message || "");
        if (m) state.connecting.delete(m[1]);
      }
    });
  }

  // The lowest-id survivor takes over the introducer — excluding the host that
  // just left (it can still linger in our roster until the WebRTC drop fires),
  // so the survivors don't all defer to a dead peer and nobody takes over.
  function maybeReelect(deadId) {
    if (state.closed || state.isHost) return;
    const survivors = knownIds().filter((id) => id !== deadId);
    if (survivors.length === 0 || survivors.reduce((a, b) => (a < b ? a : b)) === state.myId) {
      claimHost();
    }
  }

  function retry(fn, ms) {
    if (state.closed || state.isHost || state.reelectTimer) return;
    state.reelectTimer = setTimeout(() => {
      state.reelectTimer = null;
      if (!state.closed && !state.isHost) fn();
    }, ms);
  }

  // Claim the well-known introducer id (become host). Race-safe: the broker only
  // lets one peer hold it; a loser falls back to bootstrapping off the winner.
  function claimHost() {
    if (state.closed || state.isHost || state.hostListener) return;
    log("claiming introducer:", hostId);
    const listener = new Peer(hostId, PEER_OPTS);
    state.hostListener = listener;
    listener.on("open", () => {
      if (state.closed) { try { listener.destroy(); } catch (_) {} return; }
      state.isHost = true;
      state.roleSettled = true;
      state.hostMeshId = state.myId;
      log("became host (introducer)");
      wireListener(listener);
      startHostBeat(); // announce + keep announcing that we're the host
      emitStatus();
    });
    listener.on("error", (e) => {
      const type = e && e.type;
      if (state.hostListener === listener) state.hostListener = null;
      try { listener.destroy(); } catch (_) {}
      if (type === "unavailable-id") {
        bootstrap(); // someone else holds it — join them (the common guest path)
      } else {
        log("introducer-claim error", type);
        retry(claimHost, 1200);
      }
    });
  }

  // As host: introduce each newcomer that connects to the well-known id, then
  // pull them into the mesh. The introducer link carries no media/app data.
  function wireListener(listener) {
    listener.on("connection", (conn) => {
      conn.on("open", () => {
        log("introduce ->", conn.peer);
        try { conn.send({ type: "roster", peers: knownIds(), host: state.myId }); } catch (_) {}
        // The newcomer has our mesh id in that roster, so normal id-ordering
        // forms the host<->newcomer link with no glare: we dial only if our id
        // is lower, otherwise the newcomer dials us.
        tryConnect(conn.peer);
        // The introducer link itself isn't a mesh connection; drop it once the
        // newcomer has the roster.
        setTimeout(() => { try { conn.close(); } catch (_) {} }, 5000);
      });
      conn.on("error", () => {});
    });
    listener.on("disconnected", () => {
      if (!state.closed) { try { listener.reconnect(); } catch (_) {} }
    });
    listener.on("error", (e) => log("introducer error", e && e.type));
  }

  // Connect to the introducer only long enough to learn the roster, then mesh
  // directly. This is the fast path for guests (the common case). If no
  // introducer answers, claim the id and become the host.
  function bootstrap() {
    if (state.closed || state.isHost) return;
    log("bootstrap -> introducer");
    let conn;
    try { conn = state.peer.connect(hostId, { reliable: true }); } catch (_) { retry(claimHost, 600); return; }
    let got = false;
    conn.on("data", (msg) => {
      if (msg && msg.type === "roster" && Array.isArray(msg.peers)) {
        got = true;
        if (msg.host) { state.hostMeshId = msg.host; state.lastHostBeat = Date.now(); }
        if (!state.roleSettled) { state.roleSettled = true; emitStatus(); } // settled as a guest
        msg.peers.forEach((id) => tryConnect(id));
      }
    });
    conn.on("error", (e) => {
      log("bootstrap error", e && e.type);
      if (!got && !state.isHost) retry(claimHost, 600); // no introducer → claim it
    });
    // No roster and still nobody after a beat → introducer is gone; claim it.
    setTimeout(() => {
      if (!state.closed && !got && !state.isHost && state.connections.size === 0) claimHost();
    }, 6000);
  }

  // As host: repeatedly announce ourselves so survivors can detect us leaving
  // quickly (without waiting on the WebRTC ICE timeout).
  function startHostBeat() {
    if (state.beatTimer) return;
    broadcastToMesh({ type: "host", id: state.myId });
    state.beatTimer = setInterval(() => {
      if (state.closed || !state.isHost) return;
      broadcastToMesh({ type: "host", id: state.myId });
    }, HOST_BEAT_MS);
  }

  // As guest: if the host's heartbeat goes quiet, trigger re-election. Because
  // the WebRTC drop is slow, the dead host can still linger in our roster — so
  // we drop its ghost here and exclude it from the election.
  function startLivenessCheck() {
    if (state.livenessTimer) return;
    state.livenessTimer = setInterval(() => {
      if (state.closed || state.isHost || !state.hostMeshId) return;
      if (Date.now() - state.lastHostBeat > HOST_TIMEOUT_MS) {
        const dead = state.hostMeshId;
        state.hostMeshId = null;
        log("host heartbeat timeout -> re-election");
        if (state.connections.has(dead)) dropPeer(dead); // clear the ghost tile
        maybeReelect(dead);
      }
    }, 2000);
  }

  function broadcastToMesh(msg) {
    state.connections.forEach((c) => {
      try { if (c.open) c.send(msg); } catch (_) {}
    });
  }

  // Start: take a random mesh id, then become host or bootstrap.
  const peer = new Peer(undefined, PEER_OPTS);
  state.peer = peer;
  peer.on("open", (id) => {
    state.myId = id;
    log("mesh id", id);
    wireCommon();
    startLivenessCheck();
    emitStatus();
    claimHost(); // claim the introducer (become host); if taken, bootstrap off it
  });
  peer.on("error", (e) => {
    const type = e && e.type;
    log("mesh peer error", type);
    if (type === "peer-unavailable") {
      const m = /peer (\S+)/.exec(e.message || "");
      if (m) state.connecting.delete(m[1]);
    } else if (!state.myId) {
      emitStatus({ error: type || String(e) });
    }
  });

  return {
    // Send an application payload to every connected peer.
    broadcast(data) {
      const msg = { type: "app", data };
      state.connections.forEach((c) => {
        try { if (c.open) c.send(msg); } catch (_) {}
      });
    },
    // Send an application payload to a single peer.
    sendTo(id, data) {
      const c = state.connections.get(id);
      if (c && c.open) {
        try { c.send({ type: "app", data }); } catch (_) {}
      }
    },
    // Start sharing a screen stream to every connected peer (and future joiners).
    startScreen(stream) {
      state.screenStream = stream;
      state.connections.forEach((_, id) => placeScreenCall(id));
    },
    // Stop sharing: close all outgoing screen calls.
    stopScreen() {
      state.screenStream = null;
      state.screenCalls.forEach((c) => { try { c.close(); } catch (_) {} });
      state.screenCalls.clear();
    },
    leave() {
      state.closed = true;
      if (state.reelectTimer) { clearTimeout(state.reelectTimer); state.reelectTimer = null; }
      if (state.beatTimer) { clearInterval(state.beatTimer); state.beatTimer = null; }
      if (state.livenessTimer) { clearInterval(state.livenessTimer); state.livenessTimer = null; }
      state.dialTimers.forEach((t) => clearTimeout(t));
      state.dialTimers.clear();
      state.screenCalls.forEach((c) => { try { c.close(); } catch (_) {} });
      state.calls.forEach((c) => { try { c.close(); } catch (_) {} });
      state.connections.forEach((c) => { try { c.close(); } catch (_) {} });
      try { state.hostListener && state.hostListener.destroy(); } catch (_) {}
      try { state.peer && state.peer.destroy(); } catch (_) {}
    },
    getState: () => state,
  };
}
