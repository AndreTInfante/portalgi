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

export function buildTextures() {
  // Plaster: warm off-white with soft mottling. Wall UVs span v=0 (floor) to v=1
  // (ceiling) exactly once, so the dark strip at v<0.045 reads as a baseboard.
  const plaster = makeCanvasTex(256, (u, v) => {
    const n = fbm(u * 12, v * 12, 4, 12);
    if (v < 0.045) {
      const l = 62 + n * 18;
      return [l, l * 0.92, l * 0.85];
    }
    let l = 225 + (n - 0.5) * 18;
    return [l, l * 0.985, l * 0.955];
  });
  // walls span v exactly once; clamp so filtering can't wrap the baseboard to the top
  plaster.wrapT = THREE.ClampToEdgeWrapping;

  // Same plaster without the baseboard, for ceilings and tiling surfaces.
  const plasterPlain = makeCanvasTex(256, (u, v) => {
    const n = fbm(u * 12, v * 12, 4, 12);
    const l = 228 + (n - 0.5) * 14;
    return [l, l * 0.99, l * 0.965];
  });

  // Wood: planks along u, random shade per plank, thin dark seams.
  const wood = makeCanvasTex(512, (u, v) => {
    const plankV = 6, plankU = 2;
    const pu = Math.floor(u * plankU), pv = Math.floor(v * plankV);
    const shade = 0.72 + 0.24 * hash2(pu * 13 + 7, pv * 29 + 3);
    const grain = fbm(u * 5 + pv * 3.7, v * 90, 3, 512);
    let l = (108 + grain * 34) * shade;
    const seamV = Math.abs(v * plankV - Math.round(v * plankV));
    const seamU = Math.abs(u * plankU - Math.round(u * plankU));
    if (seamV < 0.012 || seamU < 0.006) l *= 0.45;
    return [l * 1.05, l * 0.78, l * 0.55];
  });

  // Marble: light gray with darker veins (domain-warped fbm).
  const marble = makeCanvasTex(512, (u, v) => {
    const w1 = fbm(u * 6, v * 6, 4, 6);
    const vein = Math.abs(Math.sin((u * 4 + w1 * 3.0) * Math.PI));
    const veins = Math.pow(1 - vein, 8);
    let l = 208 + (w1 - 0.5) * 12 - veins * 70;
    return [l, l, l * 1.015];
  });

  // Concrete: mid-gray noise with faint large blotches.
  const concrete = makeCanvasTex(256, (u, v) => {
    const n = fbm(u * 16, v * 16, 4, 16) * 0.6 + fbm(u * 3, v * 3, 2, 3) * 0.4;
    const l = 135 + (n - 0.5) * 26;
    return [l, l, l * 0.98];
  });

  // Walnut: dark warm wood for frames/benches.
  const walnut = makeCanvasTex(128, (u, v) => {
    const n = fbm(u * 3, v * 24, 3, 24);
    const l = 52 + n * 26;
    return [l * 1.25, l * 0.85, l * 0.6];
  });

  const white = makeCanvasTex(4, () => [255, 255, 255]);

  return { plaster, plasterPlain, wood, marble, concrete, walnut, white };
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
