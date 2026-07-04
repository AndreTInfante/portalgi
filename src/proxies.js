// Hand-authored occluder capsule sets. Auto-fit (per-submesh boxes / vertex
// bands) is the fallback; anything keyed here overrides it. Author in-app:
// load with ?occedit=1, tweak in the 'Occluder editor' GUI folder, DUMP, and
// paste the JSON back into this file.
//
// statics: WORLD-space capsules (statues never move). Keyed by model slug.
// props:   PROP-LOCAL capsules (transformed by the prop matrix per frame).
// Each capsule is [[ax, ay, az], [bx, by, bz], radius]; a == b is a sphere.
//
// The statue sets below are a first pass authored from geometry + renders -
// refine by eye in the editor.
export const OCCLUDER_PROXIES = {
  statics: {
    // rearing horse at (0, 13.3), 2.2m, facing west: plinth+base discs,
    // haunches on the east side, body rising diagonally west, neck/head high
    horse_statue_01: [
      [[0, 0.0, 13.3], [0, 0.18, 13.3], 0.58],       // plinth + marble base
      [[0.32, 0.35, 13.3], [0.42, 1.0, 13.3], 0.38], // hind legs / rump
      [[0.3, 1.05, 13.3], [-0.35, 1.5, 13.3], 0.34], // torso diagonal
      [[-0.35, 1.5, 13.3], [-0.68, 2.0, 13.3], 0.22],// neck + head
      [[-0.5, 1.15, 13.3], [-0.82, 1.4, 13.3], 0.14],// raised forelegs
    ],
    // breaching whale at (13.4, -15.8), 2.4m, rotY pi/5: base disc, thin
    // stand, body arcing up along the facing direction, fluke high
    bronze_whale_statue: [
      [[13.4, 0.0, -15.8], [13.4, 0.12, -15.8], 0.55],   // base disc
      [[13.4, 0.1, -15.8], [13.4, 0.72, -15.8], 0.13],   // stand
      [[13.16, 0.85, -16.12], [13.74, 1.85, -15.33], 0.45], // body arc
      [[13.74, 1.85, -15.33], [14.02, 2.28, -15.0], 0.24],  // tail / fluke
    ],
  },
  props: {
    // dynamic model props: author in local space via ?occedit=1 and paste here
  },
};
