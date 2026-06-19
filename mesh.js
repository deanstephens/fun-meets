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

export function joinRoom({ room, localStream, onStatus, onPeerStream, onPeerLeft, onPeerJoin, onMessage }) {
  const hostId = ROOM_PREFIX + room + "-host";

  const state = {
    peer: null,
    myId: null,
    isHost: false,
    connections: new Map(), // peerId -> DataConnection
    connecting: new Set(), // peerIds currently being dialed
    calls: new Map(), // peerId -> MediaConnection
    closed: false,
  };

  const log = (...a) => console.log("[mesh]", ...a);

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
    wireData(state.peer.connect(id, { reliable: true }));
  }

  function broadcastRoster() {
    const msg = { type: "roster", peers: knownIds() };
    state.connections.forEach((c) => {
      try { if (c.open) c.send(msg); } catch (_) {}
    });
  }

  function wireData(conn) {
    conn.on("open", () => {
      state.connecting.delete(conn.peer);
      state.connections.set(conn.peer, conn);
      log("data open <->", conn.peer);
      // Tell EVERYONE (including the newcomer) the current roster, so existing
      // peers learn about later joiners — not just whoever connects to them.
      // tryConnect is idempotent and id-ordered, so this never storms.
      broadcastRoster();
      // Lower id places the media call.
      if (state.myId < conn.peer) placeCall(conn.peer);
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

  function wireCall(call) {
    state.calls.set(call.peer, call);
    call.on("stream", (remoteStream) => {
      // The underlying RTCPeerConnection exists by now — watch it so an
      // abruptly-dropped peer (tab crash, network loss) is cleaned up, not
      // just a graceful leave that closes the connection for us.
      monitorIce(call.peerConnection, call.peer);
      if (onPeerStream) onPeerStream(call.peer, remoteStream);
    });
    call.on("close", () => dropPeer(call.peer));
    call.on("error", (e) => log("call error", call.peer, e && e.type));
  }

  function monitorIce(pc, id) {
    if (!pc) return;
    pc.addEventListener("iceconnectionstatechange", () => {
      const s = pc.iceConnectionState;
      if (s === "failed" || s === "closed" || s === "disconnected") {
        log("ice", s, "->", id);
        dropPeer(id);
      }
    });
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
    state.connecting.delete(id);
    if (changed) {
      log("peer left", id);
      if (onPeerLeft) onPeerLeft(id);
      emitStatus();
    }
  }

  function wireCommon() {
    state.peer.on("connection", (conn) => wireData(conn));
    state.peer.on("call", (call) => {
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
    leave() {
      state.closed = true;
      state.calls.forEach((c) => { try { c.close(); } catch (_) {} });
      state.connections.forEach((c) => { try { c.close(); } catch (_) {} });
      try { state.peer && state.peer.destroy(); } catch (_) {}
    },
    getState: () => state,
  };
}
