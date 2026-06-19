// faceframe.js — optional auto-framing of the local camera on the user's face.
//
// A hidden <video> plays the raw camera; a square <canvas> is drawn each frame
// cropped/zoomed to the detected face (smoothed). The canvas is exposed as a
// MediaStream (canvas video track + the original audio track) so the *framed*
// video is what's shown locally AND sent to peers over WebRTC.
//
// Face detection uses MediaPipe Tasks Vision (WASM, loaded lazily from a CDN).
// Everything degrades gracefully: if the model can't load or no face is found,
// the canvas just shows the full centre-cropped frame.

const MP = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18";
const MODEL =
  "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite";

// Compute the source-space square crop {cx, cy, size} that frames a face so it
// fills `faceFrac` of the crop. With no face, returns the largest centred
// square (a plain centre crop). Pure + DOM-free so it can be unit-tested.
export function computeCrop(face, vw, vh, faceFrac = 0.55) {
  const maxSize = Math.min(vw, vh);
  if (!face) return { cx: vw / 2, cy: vh / 2, size: maxSize };
  const fcx = face.x + face.w / 2;
  const fcy = face.y + face.h / 2;
  const size = Math.max(40, Math.min(maxSize, Math.max(face.w, face.h) / faceFrac));
  const half = size / 2;
  // Bias the framing up slightly so the face sits a touch above centre.
  const cx = Math.min(Math.max(half, fcx), vw - half);
  const cy = Math.min(Math.max(half, fcy - size * 0.06), vh - half);
  return { cx, cy, size };
}

async function loadDetector() {
  const { FaceDetector, FilesetResolver } = await import(MP);
  const fileset = await FilesetResolver.forVisionTasks(MP + "/wasm");
  for (const delegate of ["GPU", "CPU"]) {
    try {
      return await FaceDetector.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL, delegate },
        runningMode: "VIDEO",
      });
    } catch (_) { /* try next delegate */ }
  }
  throw new Error("FaceDetector could not be created");
}

// Create the framer. Returns synchronously with the output stream; the detector
// loads in the background and engages once ready.
export function createFaceFramer(rawStream, { size = 480, enabled = true } = {}) {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = rawStream;
  video.play().catch(() => {});

  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");

  const state = { enabled, detector: null, target: null, cur: null, lastDetect: 0, running: true };

  loadDetector()
    .then((d) => { state.detector = d; })
    .catch((e) => console.warn("[faceframe] detector unavailable, full-frame fallback:", e && e.message));

  function detect(now) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!state.detector || !state.enabled || !vw) { state.target = null; return; }
    try {
      const res = state.detector.detectForVideo(video, now);
      const d = res && res.detections && res.detections[0];
      if (d && d.boundingBox) {
        const b = d.boundingBox;
        state.target = computeCrop({ x: b.originX, y: b.originY, w: b.width, h: b.height }, vw, vh);
      } else {
        state.target = null;
      }
    } catch (_) { /* keep last target */ }
  }

  function draw(now) {
    if (!state.running) return;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (vw) {
      if (now - state.lastDetect > 200) { state.lastDetect = now; detect(now); }
      const target = state.enabled && state.target ? state.target : computeCrop(null, vw, vh);
      if (!state.cur) state.cur = { ...target };
      const k = 0.18; // smoothing toward the target crop
      state.cur.cx += (target.cx - state.cur.cx) * k;
      state.cur.cy += (target.cy - state.cur.cy) * k;
      state.cur.size += (target.size - state.cur.size) * k;
      const s = state.cur.size;
      ctx.drawImage(video, state.cur.cx - s / 2, state.cur.cy - s / 2, s, s, 0, 0, size, size);
    }
    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);

  const canvasStream = canvas.captureStream(30);
  const out = new MediaStream([...canvasStream.getVideoTracks(), ...rawStream.getAudioTracks()]);

  return {
    stream: out,
    setEnabled(v) { state.enabled = !!v; },
    isEnabled() { return state.enabled; },
    stop() {
      state.running = false;
      try { state.detector && state.detector.close(); } catch (_) {}
      canvasStream.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
    },
  };
}
