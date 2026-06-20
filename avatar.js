// avatar.js — composable avatar built from PNG clothing assets overlaid on a
// stick figure.
//
// The webcam circle is the head. Below it a small stick figure is assembled
// from HTML elements so each limb can swing independently for the walk cycle:
//   * arms  — always stick lines (kept separate from the body so they swing)
//   * legs  — stick lines, or a per-leg clothing PNG (jeans/suit/shorts)
//   * torso — bare spine, or a clothing PNG (tees, hoodie, armor, …)
//   * feet  — none, or a shoe PNG attached to each (swinging) leg
//   * hat   — a large PNG resting on top of the head
//
// Clothing is supplied as transparent PNGs under assets/avatar/<slot>/.

import { AVATAR_POSITIONS } from "./avatar-positions.js";

const ASSET_BASE = "assets/avatar";

// Apply a part's per-outfit calibration offset (if any) as CSS variables that
// the part's transform composes in (see style.css). slot is the AVATAR_OPTIONS
// slot, key is the chosen option.
export function applyAdjust(el, slot, key) {
  const a = AVATAR_POSITIONS[slot] && AVATAR_POSITIONS[slot][key];
  if (!a) return;
  if (a.x) el.style.setProperty("--ax", a.x + "px");
  if (a.y) el.style.setProperty("--ay", a.y + "px");
  if (a.scale != null && a.scale !== 1) el.style.setProperty("--as", String(a.scale));
}

// Per-torso shoulder (arm pivot) defaults, in the figure's local coords; the
// figure is 80px wide so the centre is 40. sx is the half-spread, sy the height.
export const SHOULDER_CENTER = 40;
export const SHOULDER_SX = 6.5;
export const SHOULDER_SY = 13;

// Arm segmentation: total arm length, the default upper-arm length (the rest is
// the forearm), and the resting elbow angle. The two segments are 50px total
// (upper 26 + forearm 24); elbow 0deg renders them straight/collinear.
export const ARM_LEN = 50;
export const UPPER_ARM = 26;
export const ELBOW_REST = 0;

// Set the arm rig (shoulder pivot + elbow) on the figure from the body outfit's
// calibrated values. The arm parts read --sh-lx/--sh-rx/--sh-y (shoulder),
// --upperarm (elbow position) and --elbow (resting forearm angle).
export function applyArmRig(fig, bodyOption) {
  const a = AVATAR_POSITIONS.body && AVATAR_POSITIONS.body[bodyOption];
  if (!a) return;
  if (a.sx != null) {
    fig.style.setProperty("--sh-lx", SHOULDER_CENTER - a.sx + "px");
    fig.style.setProperty("--sh-rx", SHOULDER_CENTER + a.sx + "px");
  }
  if (a.sy != null) fig.style.setProperty("--sh-y", a.sy + "px");
  if (a.ua != null) fig.style.setProperty("--upperarm", a.ua + "px");
  if (a.elbow != null) fig.style.setProperty("--elbow", a.elbow + "deg");
}

export const AVATAR_OPTIONS = {
  hat: ["none", "pirate", "tophat", "crown", "beanie", "cowboy", "wizard"],
  body: ["none", "tshirt", "hoodie", "tux", "dress", "striped", "overalls",
    "steel", "leather", "royal", "tunic", "gi", "knight"],
  legs: ["none", "jeans", "suit", "shorts"],
  feet: ["none", "sneaker", "boot", "dressshoe"],
};

export const SLOT_LABELS = { hat: "Hat", body: "Body", legs: "Legs", feet: "Feet" };

export const OPTION_LABELS = {
  none: "None",
  pirate: "Pirate", tophat: "Top hat", crown: "Crown", beanie: "Beanie",
  cowboy: "Cowboy", wizard: "Wizard",
  tshirt: "T-shirt", hoodie: "Hoodie", tux: "Tux", dress: "Dress",
  striped: "Striped", overalls: "Overalls",
  steel: "Steel", leather: "Leather", royal: "Royal", tunic: "Tunic",
  gi: "Gi", knight: "Knight",
  jeans: "Jeans", suit: "Suit", shorts: "Shorts",
  sneaker: "Sneaker", boot: "Boot", dressshoe: "Dress shoe",
};

export const DEFAULT_AVATAR = { hat: "none", body: "none", legs: "none", feet: "none" };

// Coerce a possibly-partial or untrusted (peer-supplied) config to safe values.
export function normalizeAvatar(cfg) {
  const out = { ...DEFAULT_AVATAR };
  if (cfg && typeof cfg === "object") {
    for (const slot of Object.keys(AVATAR_OPTIONS)) {
      if (AVATAR_OPTIONS[slot].includes(cfg[slot])) out[slot] = cfg[slot];
    }
  }
  return out;
}

function div(cls) {
  const d = document.createElement("div");
  d.className = cls;
  return d;
}

function asset(slot, name, cls) {
  const img = document.createElement("img");
  img.className = cls;
  img.src = `${ASSET_BASE}/${slot}/${name}.png`;
  img.alt = "";
  img.draggable = false;
  return img;
}

function legEl(side, cfg) {
  const leg = div("limb leg leg-" + side);
  if (cfg.legs === "none") {
    leg.appendChild(div("stick"));
  } else {
    const cloth = asset("legs", `${cfg.legs}-${side}`, "cloth");
    applyAdjust(cloth, "legs", cfg.legs);
    leg.appendChild(cloth);
  }
  if (cfg.feet !== "none") {
    const foot = asset("feet", cfg.feet, "foot foot-" + side);
    applyAdjust(foot, "feet", cfg.feet);
    leg.appendChild(foot);
  }
  return leg;
}

export function buildFigure(cfg) {
  const fig = div("figure");
  // Legs first (behind), then torso, then arms in front.
  fig.appendChild(legEl("l", cfg));
  fig.appendChild(legEl("r", cfg));

  const torso = div("torso");
  if (cfg.body === "none") {
    torso.appendChild(div("spine"));
  } else {
    const cloth = asset("body", cfg.body, "cloth");
    applyAdjust(cloth, "body", cfg.body);
    torso.appendChild(cloth);
    applyArmRig(fig, cfg.body); // shoulder pivots + elbow for this top
  }
  fig.appendChild(torso);

  fig.appendChild(armEl("l"));
  fig.appendChild(armEl("r"));
  return fig;
}

// An arm in two segments hinged at the elbow: an upper arm (pivots at the
// shoulder) holding a forearm (pivots at the elbow). Defaults render straight.
function armEl(side) {
  const arm = div("limb arm arm-" + side);
  arm.appendChild(div("stick")); // upper arm
  const forearm = div("forearm");
  forearm.appendChild(div("stick")); // forearm
  arm.appendChild(forearm);
  return arm;
}

export function buildHat(type) {
  if (!type || type === "none") return null;
  const hat = asset("hat", type, "hat-img");
  applyAdjust(hat, "hat", type);
  return hat;
}

// Replace a tile's avatar parts (figure + hat) with ones built from cfg.
export function applyAvatar(tileEl, cfg) {
  tileEl.querySelectorAll(":scope > .figure, :scope > .hat-img").forEach((n) => n.remove());
  tileEl.appendChild(buildFigure(cfg));
  const hat = buildHat(cfg.hat);
  if (hat) tileEl.appendChild(hat);
}
