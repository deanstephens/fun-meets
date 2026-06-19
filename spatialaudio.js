// spatialaudio.js — proximity-based audio: each remote peer's volume scales
// with the distance between avatars on the board. Pure WebAudio, fully
// client-side (no server, no extra bandwidth — it just shapes received audio).

// Volume for a normalized board distance: 1 up close, smoothly down to 0 far
// away. Pure + DOM-free so it can be unit-tested.
export function gainForDistance(d, nearR = 0.14, farR = 0.62) {
  if (d <= nearR) return 1;
  if (d >= farR) return 0;
  const t = (d - nearR) / (farR - nearR);
  return 1 - t * t * (3 - 2 * t); // 1 - smoothstep
}

export function createSpatialAudio() {
  const AC = window.AudioContext || window.webkitAudioContext;
  let ctx = null;
  let enabled = true;
  const peers = new Map(); // id -> { source, gain, videoEl }

  function ensureCtx() {
    if (!ctx && AC) {
      try { ctx = new AC(); } catch (_) {}
    }
    if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
    return ctx;
  }

  // Route a peer's audio through a gain node. The <video> element keeps the
  // WebRTC audio pipeline alive but is muted, so the only audio path is WebAudio
  // (a known requirement for WebAudio + WebRTC, and avoids double audio).
  function addPeer(id, stream, videoEl) {
    if (peers.has(id)) return;
    if (!stream || !stream.getAudioTracks().length) return;
    if (!ensureCtx()) return; // no WebAudio -> element plays audio (fallback)
    try {
      const source = ctx.createMediaStreamSource(stream);
      const gain = ctx.createGain();
      gain.gain.value = 1;
      source.connect(gain).connect(ctx.destination);
      if (videoEl) videoEl.muted = true;
      peers.set(id, { source, gain, videoEl });
    } catch (_) { /* leave the element audible as a fallback */ }
  }

  function removePeer(id) {
    const p = peers.get(id);
    if (!p) return;
    try { p.source.disconnect(); } catch (_) {}
    try { p.gain.disconnect(); } catch (_) {}
    if (p.videoEl) p.videoEl.muted = false;
    peers.delete(id);
  }

  // Recompute gains. targetFor(id) -> desired gain [0..1] (distance + zones,
  // computed by the caller). When disabled, everyone is full volume.
  function update(targetFor) {
    if (!ctx) return;
    peers.forEach((p, id) => {
      let target = enabled ? targetFor(id) : 1;
      if (typeof target !== "number") target = 1;
      const g = p.gain.gain;
      g.value += (target - g.value) * 0.25; // smooth toward target (no zipper)
    });
  }

  function setEnabled(v) { enabled = !!v; }
  function getGain(id) { const p = peers.get(id); return p ? p.gain.gain.value : null; }
  function peerIds() { return [...peers.keys()]; }

  return { addPeer, removePeer, update, setEnabled, getGain, peerIds };
}
