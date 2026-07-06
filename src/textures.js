// Procedural surface textures (canvas-generated) + public-domain painting loads.
import * as THREE from 'three';

function hash2(x, y) {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

// Smooth value noise, tileable over `period` cells.
function vnoise(u, v, period) {
  const xi = Math.floor(u), yi = Math.floor(v);
  const xf = u - xi, yf = v - yi;
  const sx = xf * xf * (3 - 2 * xf), sy = yf * yf * (3 - 2 * yf);
  const w = (x, y) => hash2(((x % period) + period) % period, ((y % period) + period) % period);
  const a = w(xi, yi), b = w(xi + 1, yi), c = w(xi, yi + 1), d = w(xi + 1, yi + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

function fbm(u, v, oct, period) {
  let amp = 0.5, sum = 0, freq = 1;
  for (let i = 0; i < oct; i++) {
    sum += amp * vnoise(u * freq, v * freq, period * freq);
    amp *= 0.5; freq *= 2;
  }
  return sum;
}

function makeCanvasTex(size, fill) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;
  let sr = 0, sg = 0, sb = 0, mg = 255;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const [r, g, b] = fill(x / size, y / size, x, y);
      d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255;
      sr += r; sg += g; sb += b;
      if (g < mg) mg = g;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  // min of the G channel: on ORM maps this is the guaranteed-minimum
  // roughness, which decides MATTE (traversal-free) program eligibility
  tex.userData = tex.userData || {};
  tex.userData.minG = mg / 255;
  tex.flipY = false; // keep fill()'s v == uv v (three defaults to flipping canvases)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const np = size * size * 255;
  // linear-space average albedo, used by the path tracer for bounce color
  tex.userData.avg = [(sr / np) ** 2.2, (sg / np) ** 2.2, (sb / np) ** 2.2];
  return tex;
}

// Build a full PBR set for a material: albedo canvas + normal map derived from
// a height field (finite differences, wrap-aware) + ORM (AO=1, roughness,
// metallic). fills = { albedo(u,v), height(u,v), rough(u,v), metal }
function makePBRSet(size, fills) {
  const map = makeCanvasTex(size, fills.albedo);
  const h = (u, v) => fills.height ? fills.height(((u % 1) + 1) % 1, ((v % 1) + 1) % 1) : 0;
  const e = 1 / size, strength = fills.bump !== undefined ? fills.bump : 6;
  const normalMap = makeCanvasTex(size, (u, v) => {
    const dx = (h(u + e, v) - h(u - e, v)) * strength;
    const dy = (h(u, v + e) - h(u, v - e)) * strength;
    const il = 1 / Math.hypot(dx, dy, 1);
    return [(-dx * il * 0.5 + 0.5) * 255, (-dy * il * 0.5 + 0.5) * 255, (il * 0.5 + 0.5) * 255];
  });
  normalMap.colorSpace = THREE.LinearSRGBColorSpace;
  const ormMap = makeCanvasTex(size, (u, v) => {
    const r = fills.rough ? fills.rough(u, v) : 0.9;
    return [255, Math.max(0, Math.min(255, r * 255)), (fills.metal || 0) * 255];
  });
  ormMap.colorSpace = THREE.LinearSRGBColorSpace;
  return { map, normalMap, ormMap };
}

async function loadImg(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`texture fetch failed (${res.status}): ${url}`);
  return createImageBitmap(await res.blob());
}

// Image -> CanvasTexture with the same conventions as makeCanvasTex (flipY
// false, repeat wrap, userData.avg on sRGB maps). opts:
//   tile      draw the source NxN (full source res per tile; canvas grows)
//   target    per-channel sRGB average to gain the image toward (brightness
//             correction so swapped-in photos keep the baked look's energy)
//   flatten   compress albedo contrast toward the target (1 = keep, 0 = flat);
//             photo plaster is far blotchier than clean gallery walls
//   norFlat   scale normal-map strength toward flat (1 = keep)
//   roughMul  scale the ORM roughness channel (G); lower = glossier
//   roughMin  raise the ORM roughness floor - a set whose minimum roughness
//             (x roughFactor) clears 0.65 compiles the traversal-free MATTE
//             program, so guaranteed-rough walls stop paying glossy registers
//   band      paint the baseboard strip over v < 0.045: fn(x, y) -> [r,g,b]
//   srgb      color texture (compute avg, tag SRGBColorSpace)
function makeImgTex(img, { tile = 1, target = null, flatten = 1, norFlat = 1, roughMul = 1, roughMin = 0, band = null, srgb = false } = {}) {
  const size = Math.min(img.width * tile, 2048);
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const step = size / tile;
  for (let ty = 0; ty < tile; ty++) {
    for (let tx = 0; tx < tile; tx++) ctx.drawImage(img, tx * step, ty * step, step, step);
  }
  const id = ctx.getImageData(0, 0, size, size);
  const d = id.data;
  if (target) {
    let sr = 0, sg = 0, sb = 0;
    for (let i = 0; i < d.length; i += 4) { sr += d[i]; sg += d[i + 1]; sb += d[i + 2]; }
    const np = d.length / 4;
    const g = [target[0] / (sr / np), target[1] / (sg / np), target[2] / (sb / np)];
    for (let i = 0; i < d.length; i += 4) {
      for (let ch = 0; ch < 3; ch++) {
        const v = d[i + ch] * g[ch];
        d[i + ch] = Math.min(255, target[ch] + (v - target[ch]) * flatten);
      }
    }
  }
  if (norFlat < 1) {
    for (let i = 0; i < d.length; i += 4) {
      d[i] = 128 + (d[i] - 128) * norFlat;
      d[i + 1] = 128 + (d[i + 1] - 128) * norFlat;
    }
  }
  if (roughMul !== 1) {
    for (let i = 1; i < d.length; i += 4) d[i] = Math.min(255, d[i] * roughMul);
  }
  if (roughMin > 0) {
    const floor = roughMin * 255;
    for (let i = 1; i < d.length; i += 4) if (d[i] < floor) d[i] = floor;
  }
  if (band) {
    const rows = Math.round(size * 0.045);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        const [r, g, b] = band(x, y);
        d[i] = r; d[i + 1] = g; d[i + 2] = b;
      }
    }
  }
  ctx.putImageData(id, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.flipY = false;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  let mg = 255;
  for (let i = 1; i < d.length; i += 4) if (d[i] < mg) mg = d[i];
  tex.userData.minG = mg / 255; // ORM maps: guaranteed-minimum roughness (MATTE test)
  if (srgb) {
    tex.colorSpace = THREE.SRGBColorSpace;
    let sr = 0, sg = 0, sb = 0;
    for (let i = 0; i < d.length; i += 4) { sr += d[i]; sg += d[i + 1]; sb += d[i + 2]; }
    const np = d.length / 4 * 255;
    tex.userData.avg = [(sr / np) ** 2.2, (sg / np) ** 2.2, (sb / np) ** 2.2];
  } else {
    tex.colorSpace = THREE.LinearSRGBColorSpace;
  }
  return tex;
}

// Which photo set replaces each procedural key. To swap one: drop the maps in
// assets/textures/<slug>/<slug>_{diff,nor_gl,arm}_<res>.jpg (Poly Haven's jpg
// naming) and edit the entry here. Knobs (all optional):
//   target   [r,g,b] sRGB average to steer brightness toward (omit = natural
//            color; the targets below are the procedural sets' averages, so
//            the tuned room brightness survives the swap)
//   flatten  0..1 albedo contrast around target (1 = full photo contrast)
//   norFlat  0..1 normal-map strength (1 = full)
//   roughMul scales ORM roughness; lower = glossier
export const REAL_SETS = {
  // Andre's CC0 white veined marble ships as separate maps (cgbookcase-style
  // naming): give `files` explicitly; ao + rough compose into an ORM in-loader
  marble: {
    dir: 'marble_0017_ao_1k',
    files: {
      diff: 'marble_0017_color_1k.jpg', nor: 'marble_0017_normal_opengl_1k.png',
      ao: 'marble_0017_ao_1k.jpg', rough: 'marble_0017_roughness_1k.jpg',
    },
    target: [208, 208, 211], roughMul: 0.6,
  },
  // varnished dark wood: reflects far more cleanly than plank/parquet photos
  wood: { slug: 'wood_table_001', res: '2k' },
  concrete: { slug: 'concrete_floor_worn_001', res: '1k', target: [135, 135, 132] },
  // board-formed panels with form ties: wall-styled, so walls only (floors
  // keep the plain slab above via the concrete/concreteWall key split).
  // rough ~0.5-0.75: sharp enough for the wall sheen to read (a 0.7 floor
  // sampled near-uniform max mips - boosting it did nothing visible).
  // Walls stay on the cheap zero-hop program via the explicit matte flag
  // in level.js, not the roughness threshold.
  concreteWall: { slug: 'concrete_wall_009', res: '2k', roughMin: 0.4, roughMul: 0.6 },
  walnut: { slug: 'dark_wood', res: '1k' },
  brick: { slug: 'red_bricks_04', res: '2k' }, // courtyard paving
  // mild flatten reins in the photo's stains without going flat-procedural
  // (also feeds plasterPlain = ceilings/jambs). rough lowered from the 0.7
  // matte floor for a readable eggshell sheen; matte is forced in level.js
  plaster: { slug: 'painted_plaster_wall', res: '1k', target: [230, 226, 219], flatten: 0.65, norFlat: 0.7, roughMin: 0.4, roughMul: 0.6 },
};

// AO (R) + roughness (G) images -> one ORM texture (metal = 0)
function makeOrmTex(aoImg, roughImg, { roughMul = 1, roughMin = 0 } = {}) {
  const size = Math.min(Math.max(aoImg.width, roughImg.width), 2048);
  const grab = img => {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const x = c.getContext('2d');
    x.drawImage(img, 0, 0, size, size);
    return { c, x, d: x.getImageData(0, 0, size, size) };
  };
  const ao = grab(aoImg), ro = grab(roughImg);
  const d = ao.d.data, rd = ro.d.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i + 1] = Math.max(Math.min(255, rd[i] * roughMul), roughMin * 255);
    d[i + 2] = 0;
  }
  ao.x.putImageData(ao.d, 0, 0);
  const tex = new THREE.CanvasTexture(ao.c);
  tex.flipY = false;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  tex.colorSpace = THREE.LinearSRGBColorSpace;
  let mg = 255;
  for (let i = 1; i < d.length; i += 4) if (d[i] < mg) mg = d[i];
  tex.userData.minG = mg / 255;
  return tex;
}

// Swap the procedural sets for photo sets (CC0). Fetch failure throws; the
// caller keeps the procedural fallback.
export async function applyRealTextures(textures) {
  // default: Poly Haven jpg naming inside assets/textures/<slug>/;
  // sets with explicit `files` (+ optional `dir`) may split ORM into ao+rough
  const filesOf = s => s.files || {
    diff: `${s.slug}_diff_${s.res}.jpg`,
    nor: `${s.slug}_nor_gl_${s.res}.jpg`,
    arm: `${s.slug}_arm_${s.res}.jpg`,
  };
  const keys = Object.keys(REAL_SETS);
  const all = await Promise.all(keys.map(k => {
    const s = REAL_SETS[k];
    const f = filesOf(s);
    const url = file => `./assets/textures/${s.dir || s.slug}/${file}`;
    const parts = f.arm ? [f.diff, f.nor, f.arm] : [f.diff, f.nor, f.ao, f.rough];
    return Promise.all(parts.map(p => loadImg(url(p))));
  }));
  // NOTE each map gets ONLY its own opts: norFlat/roughMul rescale channels
  // and would tint the albedo if spread into the diffuse call (they did)
  const set = (imgs, opts = {}) => ({
    map: makeImgTex(imgs[0], { tile: opts.tile, target: opts.target,
      flatten: opts.flatten, srgb: true, band: opts.bandAlbedo }),
    normalMap: makeImgTex(imgs[1], { tile: opts.tile, norFlat: opts.norFlat,
      band: opts.band && (() => [128, 128, 255]) }),
    ormMap: imgs.length > 3
      ? makeOrmTex(imgs[2], imgs[3], opts)
      : makeImgTex(imgs[2], { tile: opts.tile, roughMul: opts.roughMul,
          roughMin: opts.roughMin,
          // trim band rough 0.72 (was 0.45): the band shares the wall
          // material, and one glossy pixel would disqualify walls from the
          // traversal-free MATTE program
          band: opts.band && (() => [255, 184, 0]) }),
  });
  // baseboard strip painted back over the wall set, matching the procedural one
  const bb = (x, y) => {
    const n = fbm(x / 1024 * 12, y / 1024 * 12, 4, 12);
    const l = 62 + n * 18;
    return [l, l * 0.92, l * 0.85];
  };
  keys.forEach((k, i) => {
    const { slug, res, dir, files, ...opts } = REAL_SETS[k];
    if (k !== 'plaster') { textures[k] = set(all[i], opts); return; }
    // plaster: tile 2x2 inside the canvas (wall v spans the height exactly
    // once for the baseboard band), paint the band in, clamp vertically
    textures.plaster = set(all[i], { ...opts, tile: 2, band: true, bandAlbedo: bb });
    for (const t of [textures.plaster.map, textures.plaster.normalMap, textures.plaster.ormMap]) {
      t.wrapT = THREE.ClampToEdgeWrapping;
    }
    textures.plasterPlain = set(all[i], { ...opts, tile: 2 });
  });
}

export function buildTextures() {
  // Each entry is a PBR set: { map, normalMap, ormMap }; map.userData.avg holds
  // the linear average albedo for the path tracer.
  const plasterFills = plain => ({
    albedo: (u, v) => {
      const n = fbm(u * 12, v * 12, 4, 12);
      if (!plain && v < 0.045) { const l = 62 + n * 18; return [l, l * 0.92, l * 0.85]; }
      const l = (plain ? 228 : 225) + (n - 0.5) * 16;
      return [l, l * 0.985, l * 0.955];
    },
    height: (u, v) => fbm(u * 12, v * 12, 4, 12) * 0.6 + fbm(u * 33, v * 33, 3, 33) * 0.4,
    rough: (u, v) => 0.86 + (fbm(u * 9, v * 9, 3, 9) - 0.5) * 0.12,
    bump: 0.5,
  });
  const plaster = makePBRSet(256, plasterFills(false));
  // walls span v exactly once; clamp so filtering can't wrap the baseboard to the top
  plaster.map.wrapT = plaster.normalMap.wrapT = plaster.ormMap.wrapT = THREE.ClampToEdgeWrapping;
  const plasterPlain = makePBRSet(256, plasterFills(true));

  const plankSeam = (u, v) => {
    const sv = Math.abs(v * 6 - Math.round(v * 6)), su = Math.abs(u * 2 - Math.round(u * 2));
    return Math.min(1, Math.min(sv / 0.014, su / 0.007));
  };
  const wood = makePBRSet(256, {
    albedo: (u, v) => {
      const pu = Math.floor(u * 2), pv = Math.floor(v * 6);
      const shade = 0.72 + 0.24 * hash2(pu * 13 + 7, pv * 29 + 3);
      const grain = fbm(u * 5 + pv * 3.7, v * 90, 3, 512);
      let l = (108 + grain * 34) * shade;
      if (plankSeam(u, v) < 1) l *= 0.45;
      return [l * 1.05, l * 0.78, l * 0.55];
    },
    height: (u, v) => plankSeam(u, v) * 0.7 + fbm(u * 6, v * 80, 2, 80) * 0.3,
    rough: (u, v) => 0.2 + fbm(u * 5, v * 60, 2, 60) * 0.1 + (plankSeam(u, v) < 1 ? 0.2 : 0),
    bump: 0.5,
  });

  const veinAt = (u, v) => {
    const w1 = fbm(u * 6, v * 6, 4, 6);
    return Math.pow(1 - Math.abs(Math.sin((u * 4 + w1 * 3.0) * Math.PI)), 8);
  };
  const marble = makePBRSet(256, {
    albedo: (u, v) => {
      const w1 = fbm(u * 6, v * 6, 4, 6);
      const l = 208 + (w1 - 0.5) * 12 - veinAt(u, v) * 70;
      return [l, l, l * 1.015];
    },
    height: (u, v) => -veinAt(u, v) * 0.4,
    rough: (u, v) => 0.12 + veinAt(u, v) * 0.2,
    bump: 0.8,
  });

  const concrete = makePBRSet(256, {
    albedo: (u, v) => {
      const n = fbm(u * 16, v * 16, 4, 16) * 0.6 + fbm(u * 3, v * 3, 2, 3) * 0.4;
      const l = 135 + (n - 0.5) * 26;
      return [l, l, l * 0.98];
    },
    height: (u, v) => fbm(u * 16, v * 16, 4, 16),
    rough: (u, v) => 0.58 + (fbm(u * 7, v * 7, 3, 7) - 0.5) * 0.2,
    bump: 1.0,
  });

  const walnut = makePBRSet(128, {
    albedo: (u, v) => {
      const n = fbm(u * 3, v * 24, 3, 24);
      const l = 52 + n * 26;
      return [l * 1.25, l * 0.85, l * 0.6];
    },
    height: (u, v) => fbm(u * 3, v * 24, 3, 24),
    rough: (u, v) => 0.38 + fbm(u * 4, v * 30, 2, 30) * 0.15,
    bump: 0.8,
  });

  const flat = (r, g, b, rough) => makePBRSet(8, {
    albedo: () => [r, g, b],
    rough: () => rough,
  });
  const white = flat(255, 255, 255, 1);
  // canonical-ish Cornell colors (sRGB bytes)
  const cornellWhite = flat(200, 200, 200, 0.95);
  const cornellRed = flat(165, 40, 35, 0.95);
  const cornellGreen = flat(70, 145, 55, 0.95);

  return { plaster, plasterPlain, wood, marble, concrete, concreteWall: concrete,
    brick: concrete, walnut, white, cornellWhite, cornellRed, cornellGreen };
}
// name, aspect (w/h), display height in meters
export const PAINTINGS = [
  { file: 'starry_night.jpg',      aspect: 1.26, h: 1.15 },
  { file: 'pearl_earring.jpg',     aspect: 0.85, h: 1.25 },
  { file: 'great_wave.jpg',        aspect: 1.47, h: 1.05 },
  { file: 'wanderer.jpg',          aspect: 0.79, h: 1.35 },
  { file: 'impression_sunrise.jpg',aspect: 1.30, h: 1.10 },
  { file: 'milkmaid.jpg',          aspect: 0.88, h: 1.20 },
  { file: 'sunflowers.jpg',        aspect: 0.78, h: 1.30 },
  { file: 'grande_jatte.jpg',      aspect: 1.50, h: 1.20 },
];

// brushstroke relief derived from the painting ITSELF: luminance as height,
// Sobel gradients to tangent-space normals. Matches the art by construction
// (paint edges become ridges) where the wall's plaster normals would read
// as wall texture on canvas. Runs in a 2D canvas when the image lands; the
// CanvasTexture starts flat so materials can bind it up front.
function fillPaintingNormal(nt, img, strength = 2.2) {
  const W = 384;
  const H = Math.max(64, Math.round(W * img.height / img.width));
  const c = nt.image;
  c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, W, H);
  const src = ctx.getImageData(0, 0, W, H).data;
  const lum = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    lum[i] = (src[i * 4] * 0.299 + src[i * 4 + 1] * 0.587 + src[i * 4 + 2] * 0.114) / 255;
  }
  const out = ctx.createImageData(W, H);
  const L = (x, y) => lum[Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const gx = (L(x + 1, y - 1) + 2 * L(x + 1, y) + L(x + 1, y + 1)
                - L(x - 1, y - 1) - 2 * L(x - 1, y) - L(x - 1, y + 1)) / 8;
      const gy = (L(x - 1, y + 1) + 2 * L(x, y + 1) + L(x + 1, y + 1)
                - L(x - 1, y - 1) - 2 * L(x, y - 1) - L(x + 1, y - 1)) / 8;
      // v runs UP in uv space while image rows run down: +gy in image
      // coords is the correct tangent-space +y slope
      let nx = -gx * strength, ny = gy * strength, nz = 1;
      const il = 1 / Math.hypot(nx, ny, nz);
      const o = (y * W + x) * 4;
      out.data[o] = (nx * il * 0.5 + 0.5) * 255;
      out.data[o + 1] = (ny * il * 0.5 + 0.5) * 255;
      out.data[o + 2] = (nz * il * 0.5 + 0.5) * 255;
      out.data[o + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);
  nt.needsUpdate = true;
}

export function loadPaintingTextures(manager) {
  const loader = new THREE.TextureLoader(manager);
  return PAINTINGS.map(p => {
    const nc = document.createElement('canvas');
    nc.width = nc.height = 1; // flat until the image decodes
    const nctx = nc.getContext('2d');
    nctx.fillStyle = 'rgb(128,128,255)'; // a BLANK canvas decodes to
    nctx.fillRect(0, 0, 1, 1);           // garbage normals, not flat ones
    const nrm = new THREE.CanvasTexture(nc);
    nrm.wrapS = nrm.wrapT = THREE.ClampToEdgeWrapping;
    const tex = loader.load('./assets/paintings/' + p.file,
      t => fillPaintingNormal(nrm, t.image));
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.userData.nrmTex = nrm; // buildStaticMeshes binds it as the normal map
    return tex;
  });
}
