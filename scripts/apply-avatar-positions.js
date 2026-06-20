#!/usr/bin/env node
// apply-avatar-positions.js — write an avatar calibration export into the repo.
//
// Usage:
//   node scripts/apply-avatar-positions.js <export.json>
//
// Reads the JSON produced by the in-app calibration mode (?calibrate=1 -> Export
// JSON), validates it, and regenerates ../avatar-positions.js so the per-outfit
// offsets become the committed source of truth. Produces a reviewable diff.

const fs = require("fs");
const path = require("path");

const SLOTS = ["hat", "body", "legs", "feet"];
// Defaults for body arm-rig fields; must match avatar.js.
const SHOULDER_SX = 6.5;
const SHOULDER_SY = 13;
const UPPER_ARM = 26; // elbow position (upper-arm length)
const ELBOW_REST = 0; // resting forearm angle

function fail(msg) {
  console.error("error: " + msg);
  process.exit(1);
}

const inFile = process.argv[2];
if (!inFile) fail("usage: node scripts/apply-avatar-positions.js <export.json>");

let raw;
try {
  raw = JSON.parse(fs.readFileSync(inFile, "utf8"));
} catch (e) {
  fail("could not read/parse " + inFile + ": " + e.message);
}

// Validate + normalise: only known slots, numeric fields, drop no-op entries.
// Each entry keeps only its non-default fields: x/y/scale for any slot, plus
// sx/sy (shoulder spread/height) for body tops.
const clean = {};
let count = 0;
for (const slot of Object.keys(raw)) {
  if (!SLOTS.includes(slot)) fail("unknown slot: " + slot);
  for (const opt of Object.keys(raw[slot] || {})) {
    const a = raw[slot][opt] || {};
    const entry = {};
    const x = Number(a.x) || 0;
    const y = Number(a.y) || 0;
    const scale = a.scale == null ? 1 : Number(a.scale);
    if (!Number.isFinite(scale)) fail(`bad scale for ${slot}.${opt}`);
    if (x !== 0 || y !== 0 || scale !== 1) Object.assign(entry, { x, y, scale });
    if (slot === "body") {
      if (a.sx != null) {
        const sx = Number(a.sx);
        if (!Number.isFinite(sx)) fail(`bad sx for body.${opt}`);
        if (sx !== SHOULDER_SX) entry.sx = sx;
      }
      if (a.sy != null) {
        const sy = Number(a.sy);
        if (!Number.isFinite(sy)) fail(`bad sy for body.${opt}`);
        if (sy !== SHOULDER_SY) entry.sy = sy;
      }
      if (a.ua != null) {
        const ua = Number(a.ua);
        if (!Number.isFinite(ua)) fail(`bad ua for body.${opt}`);
        if (ua !== UPPER_ARM) entry.ua = ua;
      }
      if (a.elbow != null) {
        const elbow = Number(a.elbow);
        if (!Number.isFinite(elbow)) fail(`bad elbow for body.${opt}`);
        if (elbow !== ELBOW_REST) entry.elbow = elbow;
      }
    }
    if (Object.keys(entry).length === 0) continue; // no-op
    (clean[slot] = clean[slot] || {})[opt] = entry;
    count++;
  }
}

const header = `// avatar-positions.js — per-outfit calibration offsets for avatar parts.
//
// Generated/updated by scripts/apply-avatar-positions.js from an in-app
// calibration export (see the calibration mode, ?calibrate=1). Shape:
//   slot ("hat"|"body"|"legs"|"feet") -> option -> { x, y, scale }
// where x/y are pixels in the figure's local coordinate space and scale is a
// multiplier (1 = unchanged). Body tops may also carry shoulder (arm pivot)
// values { sx, sy } — half-spread and height. Missing fields default to no
// adjustment.
export const AVATAR_POSITIONS = `;

const out = header + JSON.stringify(clean, null, 2) + ";\n";
const dest = path.join(__dirname, "..", "avatar-positions.js");
fs.writeFileSync(dest, out);
console.log(`Wrote ${path.relative(process.cwd(), dest)} with ${count} adjusted outfit(s).`);
