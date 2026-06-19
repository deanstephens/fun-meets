// emoji.js — emoji particle effects for Fun Meets.
//
// Three ways to throw emoji around, all rendered into a pointer-events:none
// layer over the stage and auto-removed when their animation finishes:
//   * shower — a burst that sprays out from a point (your avatar)
//   * throw  — a single emoji arcs from a point toward a target (the mouse)
//   * trail  — a single emoji dropped behind you that drifts up and fades

export const EMOJIS = ["🎉", "❤️", "😂", "👍", "🔥", "😮", "🎈", "✨", "💯", "🤣", "😎", "🙌"];

const MAX_PARTICLES = 400; // soft cap so spamming can't pile up unbounded

const rand = (a, b) => a + Math.random() * (b - a);

// Transform string keeping the element centred on (left, top).
function t(dx, dy, extra) {
  return `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))${extra ? " " + extra : ""}`;
}

function makeEl(layer, emoji, x, y, size) {
  if (layer.childElementCount > MAX_PARTICLES) return null;
  const el = document.createElement("span");
  el.className = "emoji";
  el.textContent = emoji;
  el.style.left = x + "px";
  el.style.top = y + "px";
  el.style.fontSize = size + "px";
  layer.appendChild(el);
  return el;
}

function run(el, frames, opts) {
  if (!el) return;
  const anim = el.animate(frames, opts);
  anim.onfinish = () => el.remove();
  anim.oncancel = () => el.remove();
}

export function spawnShower(layer, emoji, x, y) {
  for (let i = 0; i < 11; i++) {
    const el = makeEl(layer, emoji, x, y, rand(20, 34));
    const ang = rand(0, Math.PI * 2);
    const dist = rand(55, 150);
    const dx = Math.cos(ang) * dist;
    const dy = Math.sin(ang) * dist;
    run(el, [
      { transform: t(0, 0) + " scale(0.3)", opacity: 0 },
      { transform: t(dx * 0.4, dy * 0.4) + " scale(1)", opacity: 1, offset: 0.2 },
      { transform: t(dx, dy + 70) + " scale(0.85)", opacity: 0 },
    ], { duration: rand(750, 1300), easing: "cubic-bezier(.2,.7,.3,1)" });
  }
}

export function spawnThrow(layer, emoji, fromX, fromY, toX, toY) {
  const el = makeEl(layer, emoji, fromX, fromY, 32);
  const dx = toX - fromX;
  const dy = toY - fromY;
  const arc = -Math.min(140, Math.hypot(dx, dy) * 0.3);
  run(el, [
    { transform: t(0, 0) + " rotate(0deg) scale(0.6)", opacity: 1 },
    { transform: t(dx * 0.5, dy * 0.5 + arc) + " rotate(200deg) scale(1.15)", opacity: 1, offset: 0.55 },
    { transform: t(dx, dy) + " rotate(400deg) scale(0.8)", opacity: 0.95 },
  ], { duration: 600, easing: "cubic-bezier(.35,.1,.5,1)" });
  // a little burst where it lands
  setTimeout(() => spawnPop(layer, emoji, toX, toY), 560);
}

function spawnPop(layer, emoji, x, y) {
  for (let i = 0; i < 6; i++) {
    const el = makeEl(layer, emoji, x, y, rand(14, 22));
    const ang = rand(0, Math.PI * 2);
    const d = rand(18, 44);
    run(el, [
      { transform: t(0, 0) + " scale(1)", opacity: 1 },
      { transform: t(Math.cos(ang) * d, Math.sin(ang) * d + 18) + " scale(0.5)", opacity: 0 },
    ], { duration: rand(380, 600), easing: "ease-out" });
  }
}

export function spawnTrail(layer, emoji, x, y) {
  const el = makeEl(layer, emoji, x + rand(-10, 10), y + rand(-6, 10), rand(18, 28));
  run(el, [
    { transform: t(0, 0) + " scale(1)", opacity: 0.95 },
    { transform: t(rand(-8, 8), -26) + ` rotate(${rand(-25, 25)}deg) scale(0.6)`, opacity: 0 },
  ], { duration: 1100, easing: "ease-out" });
}
