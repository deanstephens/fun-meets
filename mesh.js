// mesh.js — Serverless N-peer mesh for Fun Meets.
//
// Signaling runs over the PUBLIC PeerJS cloud broker (a service we do not
// operate — consistent with the project's "no server" principle); audio/video
// flows directly peer-to-peer over WebRTC.
//
// Topology: a full mesh. The first participant in a room claims a well-known
// "host" id derived from the room name and acts only as the entry point. Every
// new peer bootstraps off the host, then peers exchange rosters and dial each
// other so that every participant ends up directly connected to every other
// participant. There is no central media relay.
//
// Glare avoidance: for any pair, only the lexicographically-smaller peer id
// initiates the data connection and the media call; the larger id waits and
// answers. The host-bootstrap link is the one exception (a guest always dials
// the host first regardless of id order).

const Peer = window.Peer || (window.peerjs && window.peerjs.Peer);

const ROOM_PREFIX = "funmeets-v1-";

const PEER_OPTS = {
  config: {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
    ],
  },
};

// How long to wait for a dialed peer to connect before declaring it failed.
// Past this with no connection, it's almost always NAT/firewall traversal.
const DIAL_TIMEOUT_MS = 12000;

export function joinRoom({ room, localStream, onStatus, onPeerStream, onPeerLeft, onPeerJoin, onMessage, onPeerStatus, onLog, onScreenStream, onScreenStop }) {
  const hostId = ROOM_PREFIX + room + "-host";

  const state = {
    peer: null,
    myId: null,
    isHost: false,
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
      peerCount: state.connections.size,
      ...extra,
    });
  }

  function knownIds() {
    return [state.myId, ...state.connections.keys()];
  }

  // Decide whether to dial `id`, and do it. Safe to call repeatedly.
  function tryConnect(id, { bootstrap = false } = {}) {
    if (state.closed || !id || id === state.myId) return;
    if (state.connections.has(id) || state.connecting.has(id)) return;
    // Only the lower id initiates — except the host-bootstrap link.
    if (!bootstrap && state.myId > id) return;
    state.connecting.add(id);
    log("dial ->", id, bootstrap ? "(bootstrap)" : "");
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

  function startGuest() {
    const guest = new Peer(undefined, PEER_OPTS);
    guest.on("open", (id) => {
      state.peer = guest;
      state.myId = id;
      state.isHost = false;
      log("guest id", id);
      wireCommon();
      emitStatus();
      tryConnect(hostId, { bootstrap: true });
    });
    guest.on("error", (e) => {
      const type = e && e.type;
      log("guest error", type);
      if (type === "peer-unavailable") {
        const m = /peer (\S+)/.exec(e.message || "");
        if (m) state.connecting.delete(m[1]);
      } else if (!state.peer) {
        emitStatus({ error: type || String(e) });
      }
    });
  }

  // 1) Try to claim the well-known host id for this room.
  log("claiming host id:", hostId);
  const hostPeer = new Peer(hostId, PEER_OPTS);
  hostPeer.on("open", (id) => {
    state.peer = hostPeer;
    state.myId = id;
    state.isHost = true;
    log("became host", id);
    wireCommon();
    emitStatus();
  });
  hostPeer.on("error", (e) => {
    const type = e && e.type;
    if (type === "unavailable-id") {
      // Host already exists — join as a guest with a random id.
      log("host taken; joining as guest");
      try { hostPeer.destroy(); } catch (_) {}
      startGuest();
    } else if (!state.peer) {
      log("host-claim error", type);
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
      state.dialTimers.forEach((t) => clearTimeout(t));
      state.dialTimers.clear();
      state.screenCalls.forEach((c) => { try { c.close(); } catch (_) {} });
      state.calls.forEach((c) => { try { c.close(); } catch (_) {} });
      state.connections.forEach((c) => { try { c.close(); } catch (_) {} });
      try { state.peer && state.peer.destroy(); } catch (_) {}
    },
    getState: () => state,
  };
}
