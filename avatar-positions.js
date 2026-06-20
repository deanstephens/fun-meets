// avatar-positions.js — per-outfit calibration offsets for avatar parts.
//
// Generated/updated by scripts/apply-avatar-positions.js from an in-app
// calibration export (see the calibration mode, ?calibrate=1). Shape:
//   slot ("hat"|"body"|"legs"|"feet") -> option -> { x, y, scale }
// where x/y are pixels in the figure's local coordinate space and scale is a
// multiplier (1 = unchanged). Body tops may also carry { sx, sy } shoulder
// (arm pivot) values. Missing fields default to no adjustment.
export const AVATAR_POSITIONS = {};
