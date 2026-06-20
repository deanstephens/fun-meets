// voiceactivity.js — detect who is speaking by analysing each audio stream
// (local mic + every received remote stream) with a WebAudio AnalyserNode.
// Purely local analysis — no extra bandwidth. The analyser is not connected to
// the destination, so it produces no sound.

// Hysteresis state machine for one stream. Pure + DOM-free (unit-testable):
// rises above onThreshold -> speaking; must stay below offThreshold for holdMs
// before it drops, so it doesn't flicker between words.
export function nextSpeaking(state, rms, now, { onThreshold, offThreshold, holdMs }) {
  let { speaking, lastLoud } = state;
  if (rms >= onThreshold) {
    lastLoud = now;
    speaking = true;
  } else if (rms < offThreshold && now - lastLoud > holdMs) {
    speaking = false;
  }
  return { speaking, lastLoud };
}

export function createVoiceActivity(opts = {}) {
  const cfg = { onThreshold: 0.045, offThreshold: 0.025, holdMs: 280, ...opts };
  const AC = window.AudioContext || window.webkitAudioContext;
  let ctx = null;
  const entries = new Map(); // id -> { source, analyser, buf, speaking, lastLoud, level }

  function ensureCtx() {
    if (!ctx && AC) {
      try { ctx = new AC(); } catch (_) {}
    }
    if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
    return ctx;
  }

  function addStream(id, stream) {
    if (entries.has(id)) return;
    if (!stream || !stream.getAudioTracks().length) return;
    if (!ensureCtx()) return;
    try {
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser); // not connected onward -> silent analysis
      entries.set(id, {
        source, analyser, buf: new Float32Array(analyser.fftSize),
        speaking: false, lastLoud: 0, level: 0,
      });
    } catch (_) {}
  }

  function removeStream(id) {
    const e = entries.get(id);
    if (!e) return;
    try { e.source.disconnect(); } catch (_) {}
    try { e.analyser.disconnect(); } catch (_) {}
    entries.delete(id);
  }

  function rmsOf(e) {
    e.analyser.getFloatTimeDomainData(e.buf);
    let sum = 0;
    for (let i = 0; i < e.buf.length; i++) sum += e.buf[i] * e.buf[i];
    return Math.sqrt(sum / e.buf.length);
  }

  // Measure all streams and update speaking state.
  function poll(now) {
    if (!ctx) return;
    entries.forEach((e) => {
      e.level = rmsOf(e);
      const next = nextSpeaking(e, e.level, now, cfg);
      e.speaking = next.speaking;
      e.lastLoud = next.lastLoud;
    });
  }

  function isSpeaking(id) { const e = entries.get(id); return !!(e && e.speaking); }
  function getLevel(id) { const e = entries.get(id); return e ? e.level : null; }
  function ids() { return [...entries.keys()]; }
  // Create/resume the context; call from a user gesture (iOS requirement).
  function resume() { ensureCtx(); }

  return { addStream, removeStream, poll, isSpeaking, getLevel, ids, resume };
}
