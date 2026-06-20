// avatar-positions.js — per-outfit calibration offsets for avatar parts.
//
// Generated/updated by scripts/apply-avatar-positions.js from an in-app
// calibration export (see the calibration mode, ?calibrate=1). Shape:
//   slot ("hat"|"body"|"legs"|"feet") -> option -> { x, y, scale }
// where x/y are pixels in the figure's local coordinate space and scale is a
// multiplier (1 = unchanged). Body tops may also carry shoulder (arm pivot)
// values { sx, sy } — half-spread and height. Missing fields default to no
// adjustment.
export const AVATAR_POSITIONS = {
  "hat": {
    "pirate": {
      "x": 0,
      "y": -22,
      "scale": 1.24
    },
    "tophat": {
      "x": 0,
      "y": -48,
      "scale": 1
    },
    "crown": {
      "x": 0,
      "y": -60,
      "scale": 1
    },
    "beanie": {
      "x": 0,
      "y": -60,
      "scale": 1
    },
    "cowboy": {
      "x": 0,
      "y": -14,
      "scale": 1.32
    },
    "wizard": {
      "x": 0,
      "y": -53,
      "scale": 1.2
    }
  },
  "body": {
    "tshirt": {
      "x": 0,
      "y": 8,
      "scale": 1.23,
      "sx": 20.5,
      "sy": 16
    },
    "hoodie": {
      "x": 0,
      "y": 0,
      "scale": 1.17,
      "sx": 20,
      "sy": 17.5
    },
    "tux": {
      "x": 0,
      "y": 4,
      "scale": 1.14,
      "sx": 21,
      "sy": 17.5
    },
    "striped": {
      "x": 0,
      "y": 7,
      "scale": 1.12,
      "sx": 20,
      "sy": 16.5
    },
    "overalls": {
      "x": 0,
      "y": 6,
      "scale": 1.22,
      "sx": 21.5,
      "sy": 16
    },
    "steel": {
      "x": 0,
      "y": 7,
      "scale": 1.45,
      "sx": 22
    },
    "leather": {
      "x": 0,
      "y": 7,
      "scale": 1.35,
      "sx": 22,
      "sy": 16.5
    },
    "royal": {
      "x": 0,
      "y": 4,
      "scale": 1.47,
      "sx": 22,
      "sy": 16.5
    },
    "tunic": {
      "x": 0,
      "y": 7,
      "scale": 1.37,
      "sx": 22,
      "sy": 19.5
    },
    "gi": {
      "x": 0,
      "y": 10,
      "scale": 1.5,
      "sx": 22,
      "sy": 14.5
    },
    "knight": {
      "x": 0,
      "y": 4,
      "scale": 1.41,
      "sx": 22,
      "sy": 15
    },
    "dress": {
      "sx": 13
    }
  },
  "legs": {
    "jeans": {
      "x": 0,
      "y": 13,
      "scale": 1.61
    }
  },
  "feet": {
    "sneaker": {
      "x": 0,
      "y": 32,
      "scale": 1
    }
  }
};
