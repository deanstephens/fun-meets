// avatar.js — composable avatar parts for Fun Meets.
//
// The webcam circle is the "head". Around it we render configurable parts in
// independent slots so each can be changed on its own:
//   * hat   — sits on top of the head (none / pirate / cat ears)
//   * body  — the torso below the head (stick spine / round shirt)
//   * legs  — stick lines / rounder trousers
//   * feet  — none / shoes
// A config is a small object like { hat, body, legs, feet } that is also
// broadcast to peers so everyone sees each other's look.

const NS = "http://www.w3.org/2000/svg";

export const AVATAR_OPTIONS = {
  hat: ["none", "pirate", "cat"],
  body: ["stick", "round"],
  legs: ["stick", "round"],
  feet: ["none", "shoes"],
};

export const SLOT_LABELS = { hat: "Hat", body: "Body", legs: "Legs", feet: "Feet" };

export const OPTION_LABELS = {
  none: "None", pirate: "Pirate", cat: "Cat ears",
  stick: "Stick", round: "Round", shoes: "Shoes",
};

export const DEFAULT_AVATAR = { hat: "none", body: "stick", legs: "stick", feet: "none" };

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

// A leg + optional shoe grouped together so they swing as one while walking.
function legGroup(side, cfg) {
  const xHip = 32;
  const xEnd = side === "l" ? 18 : 46;
  const yHip = 44;
  const yFoot = 80;
  const width = cfg.legs === "round" ? 9 : 4;
  const leg = `<line class="legline" x1="${xHip}" y1="${yHip}" x2="${xEnd}" y2="${yFoot}" stroke-width="${width}" />`;
  let shoe = "";
  if (cfg.feet === "shoes") {
    const fx = xEnd + (side === "l" ? -3 : 3);
    shoe = `<ellipse class="shoe" cx="${fx}" cy="${yFoot + 1}" rx="7" ry="4" />`;
  }
  return `<g class="leg leg-${side}">${leg}${shoe}</g>`;
}

export function buildBody(cfg) {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("class", "body");
  svg.setAttribute("viewBox", "0 0 64 92");
  const torso = cfg.body === "round"
    ? '<path class="torso" d="M21,12 Q32,5 43,12 L41,45 L23,45 Z" />'
    : '<line class="spine" x1="32" y1="4" x2="32" y2="44" />';
  svg.innerHTML =
    torso +
    '<line class="arm arm-l" x1="32" y1="14" x2="15" y2="33" />' +
    '<line class="arm arm-r" x1="32" y1="14" x2="49" y2="33" />' +
    legGroup("l", cfg) +
    legGroup("r", cfg);
  return svg;
}

export function buildHat(type) {
  if (!type || type === "none") return null;
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("class", "hat hat-" + type);
  svg.setAttribute("viewBox", "0 0 100 60");
  if (type === "cat") {
    svg.innerHTML =
      '<polygon class="ear" points="16,54 26,8 50,42" />' +
      '<polygon class="ear" points="84,54 74,8 50,42" />' +
      '<polygon class="ear-in" points="25,46 28,20 41,40" />' +
      '<polygon class="ear-in" points="75,46 72,20 59,40" />';
  } else if (type === "pirate") {
    svg.innerHTML =
      '<path class="hatbase" d="M6,48 Q50,0 94,48 Q50,32 6,48 Z" />' +
      '<rect class="hatband" x="12" y="41" width="76" height="10" rx="5" />' +
      '<circle class="skull" cx="50" cy="41" r="5" />' +
      '<rect class="bone" x="46" y="46" width="8" height="2.4" rx="1" />';
  }
  return svg;
}

// Replace a tile's avatar parts (body + hat) with ones built from cfg.
export function applyAvatar(tileEl, cfg) {
  tileEl.querySelectorAll(":scope > svg.body, :scope > svg.hat").forEach((n) => n.remove());
  tileEl.appendChild(buildBody(cfg));
  const hat = buildHat(cfg.hat);
  if (hat) tileEl.appendChild(hat);
}
