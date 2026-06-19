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

const ASSET_BASE = "assets/avatar";

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
    leg.appendChild(asset("legs", `${cfg.legs}-${side}`, "cloth"));
  }
  if (cfg.feet !== "none") {
    leg.appendChild(asset("feet", cfg.feet, "foot foot-" + side));
  }
  return leg;
}

export function buildFigure(cfg) {
  const fig = div("figure");
  // Legs first (behind), then torso, then arms in front.
  fig.appendChild(legEl("l", cfg));
  fig.appendChild(legEl("r", cfg));

  const torso = div("torso");
  if (cfg.body === "none") torso.appendChild(div("spine"));
  else torso.appendChild(asset("body", cfg.body, "cloth"));
  fig.appendChild(torso);

  const armL = div("limb arm arm-l");
  armL.appendChild(div("stick"));
  const armR = div("limb arm arm-r");
  armR.appendChild(div("stick"));
  fig.appendChild(armL);
  fig.appendChild(armR);
  return fig;
}

export function buildHat(type) {
  if (!type || type === "none") return null;
  return asset("hat", type, "hat-img");
}

// Replace a tile's avatar parts (figure + hat) with ones built from cfg.
export function applyAvatar(tileEl, cfg) {
  tileEl.querySelectorAll(":scope > .figure, :scope > .hat-img").forEach((n) => n.remove());
  tileEl.appendChild(buildFigure(cfg));
  const hat = buildHat(cfg.hat);
  if (hat) tileEl.appendChild(hat);
}
