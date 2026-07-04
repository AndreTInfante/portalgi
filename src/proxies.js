// Hand-authored occluder capsule sets + blob albedo colors. Auto-fit is the
// fallback; anything keyed here (by model slug) overrides it. Author on the
// dedicated page: load the app with ?proxyedit=1, edit in the gallery view,
// DUMP, and paste the JSON body back into this file.
//
// COORDINATE FRAME (both statics and props): the model's authoring-local
// frame - scaled to its in-game size, grounded/centered exactly as the game
// places it, WITHOUT the world rotation/translation:
//   statics: world = T(def.x, 0, def.z) * R(def.rotY) * local
//   props:   world = prop root matrix * local (bbox center = origin)
// Each capsule is [[ax, ay, az], [bx, by, bz], radius]; a == b is a sphere.
// color: the blob's diffuse albedo for tinted re-emission (optional).
export const OCCLUDER_PROXIES = {
  statics: {
    // rearing horse, 2.2m: plinth+base discs, haunches, torso diagonal,
    // neck+head, raised forelegs (first pass - refine in ?proxyedit=1)
    horse_statue_01: {
      color: [0.55, 0.53, 0.5],
      capsules: [
        [[0, 0.0, 0], [0, 0.18, 0], 0.58],
        [[-0.32, 0.35, 0], [-0.42, 1.0, 0], 0.38],
        [[-0.3, 1.05, 0], [0.35, 1.5, 0], 0.34],
        [[0.35, 1.5, 0], [0.68, 2.0, 0], 0.22],
        [[0.5, 1.15, 0], [0.82, 1.4, 0], 0.14],
      ],
    },
    // breaching whale, 2.4m: base disc, thin stand, body arc, fluke
    bronze_whale_statue: {
      color: [0.35, 0.28, 0.2],
      capsules: [
        [[0, 0.0, 0], [0, 0.12, 0], 0.55],
        [[0, 0.1, 0], [0, 0.72, 0], 0.13],
        [[0, 0.85, -0.4], [0, 1.85, 0.58], 0.45],
        [[0.03, 1.85, 0.58], [0.03, 2.28, 1.01], 0.24],
      ],
    },
  },
  props: {
    // dynamic model props: author via ?proxyedit=1 and paste here
  },
};
