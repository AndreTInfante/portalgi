// Hand-authored occluder capsule sets + blob albedo colors (authored in-app:
// ?proxyedit=1, DUMP, paste here). Auto-fit is the fallback for any slug not
// keyed. Full set authored by Andre 2026-07-04.
//
// COORDINATE FRAME (both statics and props): the model's authoring-local
// frame - scaled to its in-game size, grounded/centered exactly as the game
// places it, WITHOUT the world rotation/translation:
//   statics: world = T(def.x, 0, def.z) * R(def.rotY) * local
//   props:   world = prop root matrix * local (bbox center = origin)
// Each capsule is [[ax, ay, az], [bx, by, bz], radius]; a == b is a sphere.
// color: the blob's diffuse albedo for tinted re-emission.
export const OCCLUDER_PROXIES = {
  statics: {
    horse_statue_01: {
      color: [0.658, 0.658, 0.651],
      capsules: [
        [[0.076, 0.309, 0], [0.076, 0.37, 0], 0.58],
        [[-0.031, 1.305, 0.038], [0.527, 0.745, 0.038], 0.34],
        [[-0.302, 1.777, 0.05], [0.001, 1.779, -0.05], 0.22],
        [[-0.682, 1.346, 0.02], [-0.279, 1.304, 0.02], 0.21],
      ],
    },
    bronze_whale_statue: {
      color: [0.037, 0.031, 0.024],
      capsules: [
        [[0, 0, 0], [0, 0.12, 0], 0.55],
        [[0, 0.487, 0], [0, 1.107, 0], 0.13],
        [[0.037, 1.026, -0.447], [0.037, 1.419, 0.897], 0.323],
        [[-0.363, 1.709, -1.274], [0.423, 1.697, -1.128], 0.164],
        [[0.03, 1.545, -1.187], [0.03, 1.092, -0.677], 0.19],
        [[-0.761, 1.045, 0.085], [0.821, 1.201, 0.188], 0.19],
      ],
    },
  },
  props: {
    horse_statue_01: {
      color: [0.35, 0.33, 0.3],
      capsules: [
        [[0.014, -0.403, 0], [0.014, -0.403, 0], 0.217],
        [[0.19, -0.254, 0], [-0.162, 0.306, 0], 0.12],
      ],
    },
    carved_wooden_elephant: {
      color: [0.546, 0.231, 0.038],
      capsules: [
        [[0.135, -0.046, 0], [-0.135, 0.054, 0], 0.209],
      ],
    },
    brass_pan_01: {
      color: [0.287, 0.144, 0.042],
      capsules: [
        [[0, 0, -0.245], [0, 0, 0.197], 0.028],
        [[0, -0.002, 0.132], [0, 0.001, 0.132], 0.117],
      ],
    },
    bronze_whale_statue: {
      color: [0.006, 0.003, 0.001],
      capsules: [
        [[0, 0.142, -0.425], [0, 0.22, 0.357], 0.205],
        [[0, 0.086, -0.142], [0, -0.362, 0.074], 0.231],
      ],
    },
    ceiling_fan: {
      color: [0.009, 0.009, 0.009],
      capsules: [
        [[0.001, -0.057, -0.001], [0.001, 0.057, -0.001], 0.12],
        [[0.446, -0.09, -0.001], [-0.445, -0.084, -0.001], 0.078],
        [[0.023, -0.168, -0.448], [-0.022, -0.1, 0.447], 0.078],
      ],
    },
    CoffeeCart_01: {
      color: [0.15, 0.147, 0.144],
      capsules: [
        [[0.468, 0.163, 0.126], [0.468, 0.163, 0.126], 0.178],
        [[-0.017, 0.26, 0.126], [-0.017, 0.41, 0.126], 0.267],
        [[-0.049, -0.148, 0.126], [0.419, -0.163, 0.126], 0.341],
      ],
    },
    BarberShopChair_01: {
      color: [0.053, 0.044, 0.036],
      capsules: [
        [[0, -0.302, -0.068], [0, 0.3, -0.358], 0.257],
        [[0, -0.411, -0.147], [0, -0.099, -0.133], 0.28],
      ],
    },
    mid_century_lounge_chair: {
      color: [0.332, 0.168, 0.051],
      capsules: [
        [[0, -0.101, 0.232], [0, 0.201, -0.237], 0.312],
      ],
    },
    modern_arm_chair_01: {
      color: [0.06, 0.051, 0.044],
      capsules: [
        [[0, -0.154, 0.203], [0, 0.212, -0.189], 0.429],
      ],
    },
    ClassicConsole_01: {
      color: [0.35, 0.33, 0.3],
      capsules: [
        [[-0.218, 0, 0], [0.218, 0, 0], 0.457],
      ],
    },
    ornate_mirror_01: {
      color: [0.35, 0.33, 0.3],
      capsules: [
        [[0, -0.169, 0], [0, 0.169, 0], 0.431],
      ],
    },
  },
};
