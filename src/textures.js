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
  let sr = 0, sg = 0, sb = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const [r, g, b] = fill(x / size, y / size, x, y);
      d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255;
      sr += r; sg += g; sb += b;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
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

  return { plaster, plasterPlain, wood, marble, concrete, walnut, white, cornellWhite, cornellRed, cornellGreen };
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

export function loadPaintingTextures(manager) {
  const loader = new THREE.TextureLoader(manager);
  return PAINTINGS.map(p => {
    const tex = loader.load('./assets/paintings/' + p.file);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    return tex;
  });
}
