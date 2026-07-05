// Per-probe, per-light VISIBILITY (Andre's sun-integration design,
// 2026-07-05): the probe grid can't carry direct beams, so props take
// analytic spot direct - but with no shadow rays, props lit up in geometric
// shade (worst: full sunlight under the courtyard loggia) and borrowed
// spots had to be crudely gated per-cell (uLightLocal) to not shine through
// walls. This bakes the missing visibility term where everything else
// already lives: at the probes. For each probe and each of its cell's <= 8
// analytic lights, jittered CPU shadow rays against the lightmapper's BVH
// give a 0..1 visibility fraction; the prop vertex shader interpolates it
// trilinearly (same weights as probe irradiance) and the spot loop
// multiplies it in. The sun stops lighting shade, borrowed spots light
// through doorways exactly where geometry permits, and the per-cell gate
// retires (in the vertex-diffuse path). Boot-time, geometry-only, ~25K
// rays: no bake artifact, no manifest coupling.
import * as THREE from 'three';

// Visibility samples on a DENSIFIED virtual grid: VIS_MULT x the probe grid
// per axis, same bounds. The irradiance probes are spaced for smooth
// ambience (~3-4m in the courtyard) - far too coarse for a shadow boundary:
// trilinear over 4m smeared the loggia shade into "mostly sunny", so the
// sun never turned off (Andre's report). Visibility is OUR texture, baked
// at boot - density costs only boot rays, not atlas space. The shader
// derives the dense dims arithmetically: visD = probeDims * 2 - 1.
export const VIS_MULT = 2;
const visDims = d => Math.max(1, d * VIS_MULT - 1);

// texture layout: row = cell, x = visIdx * 2 + half; RGBA8 unorm packs 4
// lights per texel, two texels = the cell's 8 light slots (list order)
export function buildLightVisTexture(level, bvh) {
  let maxVis = 1;
  for (const c of level.cells) {
    maxVis = Math.max(maxVis,
      visDims(c.probeGrid.dims[0]) * visDims(c.probeGrid.dims[1]) * visDims(c.probeGrid.dims[2]));
  }
  const W = maxVis * 2, H = level.cells.length;
  const data = new Uint8Array(W * H * 4).fill(255); // default fully visible
  const P = new THREE.Vector3();
  const target = new THREE.Vector3();
  const ray = new THREE.Ray();
  const J = 8; // jittered rays per (probe, light) - the light's soft radius
  const t0 = performance.now();
  let rays = 0;
  for (const cell of level.cells) {
    const pg = cell.probeGrid;
    const [dx, dy, dz] = [visDims(pg.dims[0]), visDims(pg.dims[1]), visDims(pg.dims[2])];
    const nL = Math.min(cell.lights.length, 8);
    if (!nL) continue;
    for (let gz = 0; gz < dz; gz++) {
      for (let gy = 0; gy < dy; gy++) {
        for (let gx = 0; gx < dx; gx++) {
          const idx = gx + dx * (gy + dy * gz);
          // EXACTLY the baker's probe placement (probeFrag): grid position,
          // then pulled 0.25m inside every hull plane, sequentially
          P.set(
            pg.min[0] + (dx > 1 ? pg.size[0] * gx / (dx - 1) : pg.size[0] * 0.5),
            pg.min[1] + (dy > 1 ? pg.size[1] * gy / (dy - 1) : pg.size[1] * 0.5),
            pg.min[2] + (dz > 1 ? pg.size[2] * gz / (dz - 1) : pg.size[2] * 0.5));
          for (const pl of cell.planes) {
            const d = pl.n.dot(P) + pl.d;
            if (d < 0.25) P.addScaledVector(pl.n, 0.25 - d);
          }
          for (let li = 0; li < nL; li++) {
            const l = cell.lights[li];
            const soft = l.soft !== undefined ? l.soft : 0.12;
            let vis = 0;
            for (let k = 0; k < J; k++) {
              // golden-spiral ball jitter over the emitter volume
              const u = Math.acos(2 * ((k * 0.618034) % 1) - 1);
              const v = k * 2.399963;
              const r = soft * Math.cbrt((k + 0.5) / J);
              target.set(
                l.pos[0] + r * Math.sin(u) * Math.cos(v),
                l.pos[1] + r * Math.cos(u),
                l.pos[2] + r * Math.sin(u) * Math.sin(v));
              ray.origin.copy(P);
              ray.direction.copy(target).sub(P);
              const dist = ray.direction.length();
              ray.direction.divideScalar(dist);
              rays++;
              // blockers within the emitter's own neighborhood (lamp
              // housings, the ceiling a lamp hangs from) don't count
              const hit = bvh.raycastFirst(ray, THREE.DoubleSide, 0.01, dist - (soft + 0.12));
              if (!hit) vis++;
            }
            const o = (cell.id * W + idx * 2 + (li >> 2)) * 4 + (li & 3);
            data[o] = Math.round(255 * vis / J);
          }
        }
      }
    }
  }
  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  // per-cell occlusion stats: "all 255" in a cell with occludable lights
  // means the rays are not hitting anything - the bake is broken, not subtle
  const stats = level.cells.map(cell => {
    const pg = cell.probeGrid;
    const n = visDims(pg.dims[0]) * visDims(pg.dims[1]) * visDims(pg.dims[2]);
    const nL = Math.min(cell.lights.length, 8);
    let lo = 255, shaded = 0, total = 0;
    for (let i = 0; i < n; i++) {
      for (let li = 0; li < nL; li++) {
        const v = data[(cell.id * W + i * 2 + (li >> 2)) * 4 + (li & 3)];
        total++;
        if (v < 240) shaded++;
        if (v < lo) lo = v;
      }
    }
    return `${cell.name}:${shaded}/${total}(min${lo})`;
  });
  console.log(`light visibility: ${rays} rays, ${(performance.now() - t0).toFixed(0)}ms | ` + stats.join(' '));
  return tex;
}
