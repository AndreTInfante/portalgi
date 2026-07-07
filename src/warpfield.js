// ADDENDUM: This did not work: creates bad artifacts unless angular error is
// extremely low, which requires a huge LUT. Deprecated.
// Portal warp fields: everything a reflection ray
// does AFTER crossing a portal is a pure function of the crossing point on
// the portal rect and the ray direction - the level is static geometry, so
// (t_beyond, terminal_cell_id) is bakeable per DIRECTED portal into a small
// 4D field: rect (s,t) x hemi-octahedral direction. The static programs'
// recursive hull walk (live registers across up to 8 hops of atlas samples -
// the occupancy ceiling) collapses to: one local hull exit, one
// local occSegment, a field tap, and one far atlas sample (traceSpecW in
// shaders.js). Near-mirror props/glass keep the real loop.
//
// Certainty: each texel bakes
// 8 jittered walks; where they disagree on the terminal cell - portal-frame
// silhouettes, grazing directions - the texel is AMBIGUOUS. A post-pass
// also zeroes certainty where the 3x3 in-tile neighborhood disagrees, so
// one runtime bilinear tap returns a ready-made fade ramp at every
// discontinuity: id and t are trustworthy wherever certainty > 0, and the
// shader fades toward the local flat sample (parallax-exact at silhouettes)
// as certainty drops. No fallback loop compiles into the static programs -
// register allocation is per-program, so a compiled-in loop would keep the
// occupancy ceiling it exists to delete.
//
// Baked on the GPU at boot (~2M texel-walks, milliseconds): pure geometry in,
// no distribution artifact, no manifest coupling, stays fresh vs level edits.
//
// Field atlas layout: one BLOCK per directed portal, a DIR x DIR grid of
// direction-bin tiles, each tile ST x ST texels over the portal rect.
// Blocks and tiles are both ST-aligned, so the whole atlas shares one
// global ST grid (the certainty pass exploits this). No tile borders: the
// runtime clamps its bilinear footprint half a texel inside the tile.
import * as THREE from 'three';
import { PLANES_OFF, PORTALS_OFF, PORTAL_STRIDE } from './hulldata.js';

export const WARP_ST = 16;   // rect texels per tile axis (coarser tiles
                              // stair-step visibly at doorway-jamb reflections)
export const WARP_DIR = 16;  // hemi-oct direction bins per axis

const VERT = /* glsl */`
in vec3 position;
void main() { gl_Position = vec4(position, 1.0); }`;

// pass 1, one draw per directed portal (viewport = its block): 8 jittered
// hull walks per texel -> majority terminal id (Boyer-Moore then recount),
// mean t over the majority, agreement fraction
const WALK_FRAG = /* glsl */`
precision highp float;
precision highp int;
layout(location = 0) out vec4 oCol;
uniform sampler2D uHullTex;
uniform vec3 uOrigin;   // portal rect corner 0
uniform vec3 uSAxis;    // unit, corner0 -> corner1
uniform vec3 uTAxis;    // unit, corner0 -> corner3
uniform vec3 uNrm;      // unit, INTO the neighbor cell
uniform vec2 uLen;      // rect extents (s, t) in meters
uniform vec2 uBlockOrigin;
uniform int uStartCell; // the neighbor: walks begin just past the crossing
vec4 hfetch(int cell, int t) { return texelFetch(uHullTex, ivec2(t, cell), 0); }

// walk the convex-cell graph from a point on the portal: analytic ray-hull
// exit, portal rect test on the exit plane, hop or terminate (the runtime
// loop's skeleton with no blending/occlusion/sampling)
vec2 walk(vec3 pos, vec3 dir, int cell) {
  vec4 h0 = hfetch(cell, 0);
  int pc = int(h0.w);
  for (int j = 0; j < 12; j++) {            // nudge inside the start hull
    if (j >= pc) break;
    vec4 pl = hfetch(cell, ${PLANES_OFF} + j);
    float d = dot(pl.xyz, pos) + pl.w;
    if (d < 1e-3) pos += pl.xyz * (1e-3 - d);
  }
  float tTot = 0.0;
  for (int i = 0; i <= 8; i++) {
    h0 = hfetch(cell, 0);
    pc = int(h0.w);
    float bestT = 1e8;
    int bestPlane = -1;
    for (int j = 0; j < 12; j++) {
      if (j >= pc) break;
      vec4 pl = hfetch(cell, ${PLANES_OFF} + j);
      float dn = dot(pl.xyz, dir);
      if (dn < -1e-5) {
        float t = -(dot(pl.xyz, pos) + pl.w) / dn;
        if (t < bestT) { bestT = t; bestPlane = j; }
      }
    }
    if (bestPlane < 0) return vec2(tTot, float(cell));
    vec3 hitP = pos + dir * bestT;
    tTot += bestT;
    int nextCell = -1;
    vec4 h1 = hfetch(cell, 1);
    if ((int(h1.w) & (1 << bestPlane)) != 0) {
      int poc = int(h1.x);
      for (int p = 0; p < 4; p++) {
        if (p >= poc) break;
        int base = ${PORTALS_OFF} + p * ${PORTAL_STRIDE};
        vec4 ph = hfetch(cell, base);
        if (int(ph.x) != bestPlane) continue;
        float insideD = 1e8;
        for (int e = 0; e < 4; e++) {
          vec4 ep = hfetch(cell, base + 1 + e);
          insideD = min(insideD, dot(ep.xyz, hitP) + ep.w);
        }
        if (insideD > 0.0) { nextCell = int(ph.y); break; }
      }
    }
    if (nextCell < 0) return vec2(tTot, float(cell));
    pos = hitP + dir * 1e-3;
    cell = nextCell;
  }
  return vec2(tTot, float(cell));
}

vec3 hemiOctDecode(vec2 uv) {
  vec2 v = uv * 2.0 - 1.0;
  vec2 p = vec2(v.x + v.y, v.x - v.y) * 0.5;
  return normalize(vec3(p.x, p.y, 1.0 - abs(p.x) - abs(p.y)));
}

void main() {
  vec2 localPx = floor(gl_FragCoord.xy) - uBlockOrigin;
  vec2 bin = floor(localPx / ${WARP_ST}.0);
  vec2 stI = localPx - bin * ${WARP_ST}.0;
  // 8 jitters over the texel's (s,t) footprint x the bin's direction footprint
  const vec4 J[8] = vec4[8](
    vec4(-0.32, -0.12,  0.28,  0.10), vec4( 0.18,  0.34, -0.30,  0.22),
    vec4( 0.40, -0.28, -0.06, -0.36), vec4(-0.14,  0.08,  0.38, -0.18),
    vec4( 0.06, -0.42,  0.12,  0.40), vec4(-0.38,  0.26, -0.22, -0.08),
    vec4( 0.30,  0.16,  0.04,  0.32), vec4(-0.08, -0.30, -0.40,  0.02));
  float ids[8];
  float ts[8];
  for (int k = 0; k < 8; k++) {
    vec2 st01 = (stI + 0.5 + J[k].xy) / ${WARP_ST}.0;
    vec2 duv = (bin + 0.5 + J[k].zw) / ${WARP_DIR}.0;
    vec3 dl = hemiOctDecode(duv);
    vec3 dir = normalize(uSAxis * dl.x + uTAxis * dl.y + uNrm * dl.z);
    vec3 P = uOrigin + uSAxis * (st01.x * uLen.x) + uTAxis * (st01.y * uLen.y);
    vec2 r = walk(P + dir * 1e-3, dir, uStartCell);
    ts[k] = r.x;
    ids[k] = r.y;
  }
  float cand = ids[0];
  int cnt = 1;
  for (int k = 1; k < 8; k++) {
    if (abs(ids[k] - cand) < 0.5) cnt++;
    else if (--cnt == 0) { cand = ids[k]; cnt = 1; }
  }
  float tSum = 0.0;
  float n = 0.0;
  for (int k = 0; k < 8; k++) {
    if (abs(ids[k] - cand) < 0.5) { tSum += ts[k]; n += 1.0; }
  }
  oCol = vec4(tSum / n, cand, n / 8.0, 1.0);
}`;

// pass 2, fullscreen: GRADE certainty by how much of the 3x3 in-tile
// neighborhood agrees on the terminal id (grading rather than a binary zero
// gives the fade band smooth shoulders instead of a hard 2-texel cliff that
// stair-steps along reflected doorway jambs). The runtime bilinear tap then
// returns a ready-made continuous fade ramp at every discontinuity.
const SPREAD_FRAG = /* glsl */`
precision highp float;
precision highp int;
layout(location = 0) out vec4 oCol;
uniform sampler2D uSrc;
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  vec4 own = texelFetch(uSrc, px, 0);
  ivec2 t0 = (px / ${WARP_ST}) * ${WARP_ST}; // blocks are ST-aligned: one global tile grid
  float same = 0.0;
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      if (dx == 0 && dy == 0) continue;
      ivec2 q = clamp(px + ivec2(dx, dy), t0, t0 + ${WARP_ST} - 1);
      if (abs(texelFetch(uSrc, q, 0).y - own.y) < 0.5) same += 1.0;
    }
  }
  oCol = vec4(own.x, own.y, own.z * smoothstep(0.3, 1.0, same / 8.0), 1.0);
}`;

// Bakes the field atlas + per-directed-portal metadata. Returns
// { texture, metaTex, W, H } - W/H feed sceneFrag as template constants
// (the field is built BEFORE the material system).
export function buildWarpField(renderer, level, hullTex) {
  const t0 = performance.now();
  const list = [];
  for (const cell of level.cells) {
    cell.portals.forEach((po, p) => list.push({ cell, po, D: cell.id * 4 + p }));
  }
  const block = WARP_DIR * WARP_ST;
  const cols = Math.ceil(Math.sqrt(list.length));
  const rowsN = Math.ceil(list.length / cols);
  const W = cols * block, H = rowsN * block;
  const mkRT = filter => new THREE.WebGLRenderTarget(W, H, {
    type: THREE.HalfFloatType, minFilter: filter, magFilter: filter,
    generateMipmaps: false, depthBuffer: false,
  });
  const rt1 = mkRT(THREE.NearestFilter);
  const rt2 = mkRT(THREE.LinearFilter); // runtime taps bilinear

  // metadata rows indexed D = cell*4 + portalSlot (sparse; MAX_PORTALS = 4):
  //   [origin, sLen] [sAxis, tLen] [tAxis, blockX] [n, blockY]
  const numD = level.cells.length * 4;
  const meta = new Float32Array(4 * numD * 4);
  // glslVersion (NOT a literal #version line): three still prepends
  // SHADER_TYPE defines to raw materials, which must follow the version
  const walkMat = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: VERT, fragmentShader: WALK_FRAG,
    uniforms: {
      uHullTex: { value: hullTex },
      uOrigin: { value: new THREE.Vector3() },
      uSAxis: { value: new THREE.Vector3() },
      uTAxis: { value: new THREE.Vector3() },
      uNrm: { value: new THREE.Vector3() },
      uLen: { value: new THREE.Vector2() },
      uBlockOrigin: { value: new THREE.Vector2() },
      uStartCell: { value: 0 },
    },
    depthTest: false, depthWrite: false,
  });
  const fsGeo = new THREE.BufferGeometry();
  fsGeo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const fsMesh = new THREE.Mesh(fsGeo, walkMat);
  fsMesh.frustumCulled = false;
  const fsScene = new THREE.Scene();
  fsScene.add(fsMesh);
  const cam = new THREE.Camera();

  const oldRT = renderer.getRenderTarget();
  const xr = renderer.xr.enabled;
  const oldAuto = renderer.autoClear;
  renderer.xr.enabled = false;
  renderer.setRenderTarget(rt1);
  renderer.clear();
  renderer.autoClear = false; // per-portal renders must not wipe prior blocks
  for (let i = 0; i < list.length; i++) {
    const { cell, po, D } = list[i];
    const c = po.corners;
    const sVec = c[1].clone().sub(c[0]), tVec = c[3].clone().sub(c[0]);
    const sLen = sVec.length(), tLen = tVec.length();
    const sAxis = sVec.divideScalar(sLen), tAxis = tVec.divideScalar(tLen);
    if (Math.abs(sAxis.dot(tAxis)) > 1e-3) {
      console.warn(`warpfield: non-rectangular portal ${cell.name} slot ${D % 4}`);
    }
    const n = cell.planes[po.planeIndex].n.clone().negate(); // INTO the neighbor
    const bx = (i % cols) * block, by = Math.floor(i / cols) * block;
    const u = walkMat.uniforms;
    u.uOrigin.value.copy(c[0]);
    u.uSAxis.value.copy(sAxis);
    u.uTAxis.value.copy(tAxis);
    u.uNrm.value.copy(n);
    u.uLen.value.set(sLen, tLen);
    u.uBlockOrigin.value.set(bx, by);
    u.uStartCell.value = po.neighbor;
    // per-block viewport via the TARGET's viewport: renderer.setViewport
    // would instead mutate the persistent CANVAS viewport, shrinking the
    // main view to one block
    rt1.viewport.set(bx, by, block, block);
    renderer.setRenderTarget(rt1); // re-bind applies the new viewport
    renderer.render(fsScene, cam);
    const o = D * 4 * 4;
    meta.set([c[0].x, c[0].y, c[0].z, sLen], o);
    meta.set([sAxis.x, sAxis.y, sAxis.z, tLen], o + 4);
    meta.set([tAxis.x, tAxis.y, tAxis.z, bx], o + 8);
    meta.set([n.x, n.y, n.z, by], o + 12);
  }
  const spreadMat = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: VERT, fragmentShader: SPREAD_FRAG,
    uniforms: { uSrc: { value: rt1.texture } },
    depthTest: false, depthWrite: false,
  });
  rt1.viewport.set(0, 0, W, H);
  fsMesh.material = spreadMat;
  renderer.setRenderTarget(rt2);
  renderer.render(fsScene, cam);
  renderer.setRenderTarget(oldRT);
  renderer.autoClear = oldAuto;
  renderer.xr.enabled = xr;

  const metaTex = new THREE.DataTexture(meta, 4, numD, THREE.RGBAFormat, THREE.FloatType);
  metaTex.minFilter = metaTex.magFilter = THREE.NearestFilter;
  metaTex.needsUpdate = true;
  console.log(`warp field: ${list.length} directed portals, ${W}x${H}, ` +
    `${(performance.now() - t0).toFixed(0)}ms`);
  return { texture: rt2.texture, metaTex, W, H, rt1, rt2 };
}
