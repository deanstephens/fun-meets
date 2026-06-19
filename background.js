// background.js — room background presets and helpers.
//
// A background is just a CSS `background` shorthand string applied to the
// stage (an empty string falls back to the stylesheet's default gradient).
// The room background is shared: changing it broadcasts the string to peers.

// The stage's default gradient, used as the "Default" swatch preview.
export const ORIGINAL_BG =
  "radial-gradient(circle at 20% 20%, rgba(108,123,255,0.25), transparent 40%)," +
  "radial-gradient(circle at 80% 70%, rgba(255,108,180,0.2), transparent 45%)," +
  "linear-gradient(135deg,#0f1020,#1b1d3a)";

export const COLOR_PRESETS = [
  { id: "default", label: "Default", css: ORIGINAL_BG, reset: true },
  { id: "midnight", label: "Midnight", css: "#0b0c1a" },
  { id: "ocean", label: "Ocean", css: "linear-gradient(135deg,#0b2545,#13315c)" },
  { id: "grape", label: "Grape", css: "linear-gradient(135deg,#241640,#3d2c5f)" },
  { id: "forest", label: "Forest", css: "linear-gradient(135deg,#0f2417,#1b3a2a)" },
  { id: "sunset", label: "Sunset", css: "linear-gradient(135deg,#3a1c40,#7a3b46,#c97b54)" },
  { id: "rose", label: "Rose", css: "linear-gradient(135deg,#3a1430,#5e2347)" },
];

export const PATTERN_PRESETS = [
  { id: "dots", label: "Dots", css: "radial-gradient(rgba(255,255,255,.13) 1.5px, transparent 1.6px) 0 0/22px 22px, #11132a" },
  { id: "grid", label: "Grid", css: "linear-gradient(rgba(255,255,255,.09) 1px, transparent 1px) 0 0/26px 26px, linear-gradient(90deg, rgba(255,255,255,.09) 1px, transparent 1px) 0 0/26px 26px, #0f1124" },
  { id: "stripes", label: "Stripes", css: "repeating-linear-gradient(45deg, #15173a 0 14px, #1b1e47 14px 28px)" },
  { id: "checker", label: "Checker", css: "conic-gradient(#15173a 90deg, #1b1e47 90deg 180deg, #15173a 180deg 270deg, #1b1e47 270deg) 0 0/40px 40px" },
];

// CSS for an image background (URL or data URL).
export function imageCss(url) {
  return `center / cover no-repeat fixed url("${url}")`;
}

// Validate a background string (possibly from a peer) before applying it.
// Allows preset gradients and url()/data: images; blocks anything that could
// break out of the single `background` declaration.
export function sanitizeBg(css) {
  if (typeof css !== "string") return "";
  if (css.length > 700000) return "";
  // Ignore characters inside a data: URL when checking for injection.
  const stripped = css.replace(/url\((?:"|')?data:[^)]*\)/gi, "url()");
  if (/[{}<>;]/.test(stripped)) return "";
  if (/javascript:/i.test(css)) return "";
  return css.trim();
}

// Read an image file, downscale it, and return a JPEG data URL via cb.
export function downscaleImage(file, maxDim, cb) {
  const reader = new FileReader();
  reader.onerror = () => cb(null);
  reader.onload = () => {
    const img = new Image();
    img.onerror = () => cb(null);
    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d").drawImage(img, 0, 0, w, h);
      cb(canvas.toDataURL("image/jpeg", 0.82));
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}
