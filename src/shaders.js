// All GLSL for the POC. Scene materials use THREE.ShaderMaterial with GLSL3;
// bake passes use RawShaderMaterial, also GLSL3 (three prepends the version line).
import { atlasGLSL } from './atlas.js';
import { PLANES_OFF, PORTALS_OFF, PORTAL_STRIDE, PROBE_META_OFF } from './hulldata.js';

// ------------------------------------------------------------------ shared GLSL

const OCT_GLSL = /* glsl */`
// Octahedral mapping, y-up hemisphere split. Decode tolerates coordinates a
// little outside [-1,1] (the fold formula IS the wrap), which is how gutter
// border texels get correct content.
vec2 octEncode(vec3 v) {
  v /= (abs(v.x) + abs(v.y) + abs(v.z));
  vec2 e = v.xz;
  if (v.y < 0.0) {
    e = (1.0 - abs(e.yx)) * vec2(e.x >= 0.0 ? 1.0 : -1.0, e.y >= 0.0 ? 1.0 : -1.0);
  }
  return e * 0.5 + 0.5;
}
vec3 octDecode(vec2 f) {
  vec3 v = vec3(f.x, 1.0 - abs(f.x) - abs(f.y), f.y);
  float t = max(-v.y, 0.0);
  v.x += v.x >= 0.0 ? -t : t;
  v.z += v.z >= 0.0 ? -t : t;
  return normalize(v);
}
`;

// atlas samplers; expects `uniform sampler2D uAtlas;` and atlas constants in scope
const ATLAS_SAMPLE_GLSL = /* glsl */`
vec3 sampleTile(int cell, int lod, vec2 octUv) {
  vec2 base = vec2(LOD_X[lod] + BORDER_PX, float(cell) * ROW_H + BORDER_PX);
  vec2 px = base + octUv * LOD_S[lod];
  return texture(uAtlas, px / ATLAS_SIZE).rgb;
}
vec3 sampleSpec(int cell, vec3 dir, float lod) {
  vec2 o = octEncode(normalize(dir));
  lod = clamp(lod, 0.0, MAX_SPEC_LOD);
  int k0 = int(lod);
  int k1 = min(k0 + 1, N_LODS - 1);
  vec3 a = sampleTile(cell, k0, o);
  vec3 b = sampleTile(cell, k1, o);
  return mix(a, b, lod - float(k0));
}
vec3 sampleIrr(int cell, vec3 n) {
  vec2 o = octEncode(normalize(n));
  vec2 base = vec2(IRR_X + BORDER_PX, float(cell) * ROW_H + BORDER_PX);
  return texture(uAtlas, (base + o * IRR_S) / ATLAS_SIZE).rgb;
}
float roughToLod(float r) {
  return clamp(6.5 * pow(max(r, 0.0), 0.65) - 0.4, 0.0, MAX_SPEC_LOD);
}
`;

// portal-hull traversal; expects uHullTex + uniforms below in scope
const TRACE_GLSL = /* glsl */`
uniform sampler2D uHullTex;
uniform int uMaxSteps;      // portal hops allowed; 0 = plain parallax-corrected cubemap
uniform float uBlendOn;
uniform float uBlendBase;   // blend band width floor, meters
uniform float uBlendRough;  // blend band growth per (roughness * meter)
uniform float uDistRough;   // roughness growth per meter of path length

vec4 hfetch(int cell, int t) { return texelFetch(uHullTex, ivec2(t, cell), 0); }

// Walk the reflection ray through the convex-cell graph.
// Each iteration: analytic ray-vs-hull exit, portal lookup on the exit plane,
// roughness-scaled edge blend, then either terminate on the local cubemap or
// hop into the neighbor cell. A straight ray can never revisit a convex cell,
// so this always makes forward progress.
vec3 traceSpec(int cell, vec3 pos, vec3 dir, float rough, out float stepsUsed) {
  vec4 h0 = hfetch(cell, 0);
  int pc = int(h0.w);
  for (int j = 0; j < ${'12'}; j++) {           // nudge start point inside the hull
    if (j >= pc) break;
    vec4 pl = hfetch(cell, ${PLANES_OFF} + j);
    float d = dot(pl.xyz, pos) + pl.w;
    if (d < 0.01) pos += pl.xyz * (0.01 - d);
  }
  vec3 acc = vec3(0.0);
  float w = 1.0;
  float tTot = 0.0;
  stepsUsed = 0.0;
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
    if (bestPlane < 0) bestT = 0.0;
    vec3 hitP = pos + dir * bestT;
    float tHit = tTot + bestT;
    float effR = min(1.0, rough * (1.0 + tHit * uDistRough));
    float lod = roughToLod(effR);
    int nextCell = -1;
    float blend = 0.0;
    if (i < uMaxSteps) {
      int poc = int(hfetch(cell, 1).x);
      for (int p = 0; p < 4; p++) {
        if (p >= poc) break;
        int base = ${PORTALS_OFF} + p * ${PORTAL_STRIDE};
        vec4 ph = hfetch(cell, base);
        if (int(ph.x) != bestPlane) continue;
        // ph.w is a per-edge bitmask: bit e set = SILHOUETTE edge (geometry
        // beyond it breaks the portal plane — pillar corner, doorframe). There
        // the actual content sits at the plane, so the local flat sample is
        // parallax-exact and blending gives cone-footprint anti-aliasing of
        // the partition. Unset = CONTINUATION edge (the neighbor has a
        // coplanar surface crossing the edge — floor under a cut, a shared
        // wall): pure recursion is already seamless there and blending would
        // ghost far-behind-plane content into a wedge.
        int silMask = int(ph.w + 0.5);
        float insideD = 1e8;
        float blendD = 1e8;
        for (int e = 0; e < 4; e++) {
          vec4 ep = hfetch(cell, base + 1 + e);
          float d = dot(ep.xyz, hitP) + ep.w;
          insideD = min(insideD, d);
          if ((silMask & (1 << e)) != 0) blendD = min(blendD, d);
        }
        if (insideD > 0.0) {
          float bw = uBlendBase + uBlendRough * effR * max(tHit, 0.3);
          blend = (uBlendOn < 0.5) ? 1.0 : clamp(blendD / bw, 0.0, 1.0);
          nextCell = int(ph.y);
          break;
        }
      }
    }
    vec3 localDir = hitP - h0.xyz;
    if (nextCell < 0 || blend <= 0.002) {
      acc += w * sampleSpec(cell, localDir, lod);
      return acc;
    }
    if (blend < 0.998) {
      acc += w * (1.0 - blend) * sampleSpec(cell, localDir, lod);
      w *= blend;
    }
    stepsUsed += 1.0;
    pos = hitP + dir * 1e-3;
    cell = nextCell;
    tTot = tHit;
    if (w < 0.005) return acc;
  }
  return acc;
}

uniform float uIrrBlend;   // meters; 0 disables cross-portal diffuse blending

// Diffuse continuity across portals: each cell captures irradiance from its own
// center, so adjacent cells disagree slightly at a shared boundary and the cut
// shows as a seam. Near a portal, blend toward the neighbor's irradiance.
// The neighbor weight must reach 1.0 (not 0.5) at the plane: normalized, that
// is a true 50/50, identical no matter which side shades the point — C0 in
// space for static seams AND in time when a prop's cell assignment flips.
// (A 0.5 weight normalizes to 2/3 self + 1/3 neighbor, which pops by
// (A-B)/3 at the flip — the classic asymmetric-blend mistake.)
vec3 blendedIrr(int cell, vec3 P, vec3 N) {
  vec3 acc = sampleIrr(cell, N);
  if (uIrrBlend < 0.001) return acc;
  float wsum = 1.0;
  int poc = int(hfetch(cell, 1).x);
  for (int p = 0; p < 4; p++) {
    if (p >= poc) break;
    int base = ${PORTALS_OFF} + p * ${PORTAL_STRIDE};
    vec4 ph = hfetch(cell, base);
    vec4 pl = hfetch(cell, ${PLANES_OFF} + int(ph.x));
    float planeD = max(dot(pl.xyz, P) + pl.w, 0.0);   // distance to the portal plane
    float lateralD = 1e8;                              // signed distance into the portal prism
    for (int e = 0; e < 4; e++) {
      vec4 ep = hfetch(cell, base + 1 + e);
      lateralD = min(lateralD, dot(ep.xyz, P) + ep.w);
    }
    float f = clamp(1.0 - planeD / uIrrBlend, 0.0, 1.0)
            * clamp(1.0 + lateralD / uIrrBlend, 0.0, 1.0);
    if (f > 0.001) {
      acc += f * sampleIrr(int(ph.y), N);
      wsum += f;
    }
  }
  return acc / wsum;
}
`;

const TONEMAP_GLSL = /* glsl */`
vec3 acesTonemap(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}
vec3 hsv2rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}
vec3 heatmap(float t) {
  return hsv2rgb(vec3(clamp(1.0 - t, 0.0, 1.0) * 0.62, 0.9, 1.0));
}
`;

// ------------------------------------------------------------------ scene shaders

export const SCENE_VERT = /* glsl */`
attribute vec2 lmuv;  // lightmap charts; absent on props (disabled attr reads 0)
varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec2 vUv;
varying vec2 vUv2;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vUv = uv;
  vUv2 = lmuv;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

export function sceneFrag(numCells) {
  return /* glsl */`
precision highp float;
layout(location = 0) out vec4 fragOut;
varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec2 vUv;
varying vec2 vUv2;

uniform sampler2D uAtlas;
uniform sampler2D uMap;
uniform sampler2D uLightmap;
uniform float uUseLightmap;
uniform int uCell;
uniform int uCellPrev;    // previous cell during a diffuse handoff crossfade (-1 = none)
uniform float uPrevMix;   // crossfade weight of the previous cell, decays over ~0.2s
uniform int uMode;        // 0 = surface, 1 = chrome, 2 = glass, 3 = debug pane, 4 = dynamic diffuse (parallax-corrected irradiance)
uniform vec3 uTint;
uniform vec3 uEmissive;
uniform float uGloss;
uniform float uRough;
uniform vec3 uLightPos[8];
uniform vec3 uLightColor[8]; // premultiplied by intensity (and crossing weight, for props)
uniform int uLightCount;
uniform float uBake;
uniform float uExposure;
uniform int uDebugMode;   // 0 off, 1 cell tint, 2 step heatmap, 3 irradiance, 4 white world

${atlasGLSL(numCells)}
${OCT_GLSL}
${ATLAS_SAMPLE_GLSL}
${TRACE_GLSL}
${TONEMAP_GLSL}

// Diffuse for dynamic objects: per-cell irradiance PROBE GRID, trilinear over
// 8 probes. Each probe was convolved at bake time from its own position with
// the parallax warp applied to the radiance BEFORE the cosine convolution —
// the correct operation order, so none of the warp-after-convolve artifacts
// (kernel skew, hull-edge creases) can appear. Convexity guarantees probes
// see their whole cell: no visibility term needed, no leaking within a cell.
vec3 probeDiffuse(int cell, vec3 P, vec3 N) {
  vec4 m0 = hfetch(cell, ${PROBE_META_OFF});
  vec4 m1 = hfetch(cell, ${PROBE_META_OFF + 1});
  vec4 m2 = hfetch(cell, ${PROBE_META_OFF + 2});
  vec3 dims = vec3(m0.w, m1.w, m2.x);
  vec3 g = clamp((P - m0.xyz) / max(m1.xyz, vec3(1e-4)), 0.0, 1.0) * (dims - 1.0);
  vec3 g0 = min(floor(g), dims - 2.0);
  vec3 f = g - g0;
  ivec3 gi = ivec3(g0 + 0.5);
  ivec3 di = ivec3(dims + 0.5);
  vec2 o = octEncode(normalize(N));
  vec3 sum = vec3(0.0);
  for (int i = 0; i < 8; i++) {
    ivec3 c = gi + ivec3(i & 1, (i >> 1) & 1, (i >> 2) & 1);
    float w = mix(1.0 - f.x, f.x, float(i & 1))
            * mix(1.0 - f.y, f.y, float((i >> 1) & 1))
            * mix(1.0 - f.z, f.z, float((i >> 2) & 1));
    if (w < 1e-4) continue;
    int idx = c.x + di.x * (c.y + di.y * c.z);
    vec2 base = vec2(PROBE_X + float(idx % PROBES_PER_ROW) * PROBE_TILE + BORDER_PX,
                     float(cell) * ROW_H + float(idx / PROBES_PER_ROW) * PROBE_TILE + BORDER_PX);
    sum += w * texture(uAtlas, (base + o * PROBE_S) / ATLAS_SIZE).rgb;
  }
  return sum;
}

vec3 directLight(vec3 P, vec3 N) {
  vec3 sum = vec3(0.0);
  for (int i = 0; i < 8; i++) {
    if (i >= uLightCount) break;
    vec3 L = uLightPos[i] - P;
    float d2 = dot(L, L);
    L *= inversesqrt(d2);
    sum += uLightColor[i] * (max(dot(N, L), 0.0) / (1.0 + d2));
  }
  return sum;
}

void main() {
  vec3 P = vWorldPos;
  vec3 N = normalize(vNormal);
  if (!gl_FrontFacing) N = -N;
  vec3 V = normalize(cameraPosition - P);
  float NoV = max(dot(N, V), 0.0);

  vec3 albedo = texture(uMap, vUv).rgb * uTint;
  if (uDebugMode == 4) albedo = vec3(0.75);

  vec3 irr = blendedIrr(uCell, P, N);
  float steps = 0.0;
  vec3 color;

  if (uMode == 1) {                      // chrome
    vec3 R = reflect(-V, N);
    vec3 F0 = vec3(0.94, 0.95, 0.96);
    vec3 F = F0 + (1.0 - F0) * pow(1.0 - NoV, 5.0);
    color = traceSpec(uCell, P, R, uRough, steps) * F;
  } else if (uMode == 2) {               // glass: chrome sampled the opposite way
    vec3 R = reflect(-V, N);
    float F = 0.04 + 0.96 * pow(1.0 - NoV, 5.0);
    vec3 refl = traceSpec(uCell, P, R, uRough, steps);
    float s2;
    vec3 thru = traceSpec(uCell, P, -R, uRough + 0.03, s2) * vec3(0.90, 0.97, 0.93);
    color = mix(thru, refl, F);
  } else if (uMode == 3) {               // debug pane: continue the eye ray straight
    // through with zero roughness — a direct, unrefracted window into the hull
    // cubemap structure (a -R trick here would mirror the lateral ray component
    // and act like an inverting lens). Faint green cast marks the glass.
    color = traceSpec(uCell, P, -V, 0.0, steps) * vec3(0.93, 1.0, 0.96);
  } else if (uMode == 4) {               // dynamic diffuse: probe-grid irradiance,
    // crossfaded over ~0.2s at cell handoff
    vec3 g = probeDiffuse(uCell, P, N);
    if (uPrevMix > 0.001 && uCellPrev >= 0) {
      g = mix(g, probeDiffuse(uCellPrev, P, N), uPrevMix);
    }
    color = albedo * g;
  } else {                               // lit surface: path-traced lightmap when
    // available (shadows/AO/global lights, no per-cell seams), else the
    // analytic per-cell lights + blended irradiance fallback
    vec3 diffuseL = uUseLightmap > 0.5 ? texture(uLightmap, vUv2).rgb
                                       : (directLight(P, N) + irr);
    color = albedo * diffuseL + uEmissive;
    if (uGloss > 0.001 && uBake < 0.5) {
      vec3 R = reflect(-V, N);
      float F = 0.04 + 0.96 * pow(1.0 - NoV, 5.0);
      color += traceSpec(uCell, P, R, uRough, steps) * F * uGloss;
    }
  }

  if (uBake > 0.5) {                     // HDR capture pass: linear, no tonemap
    fragOut = vec4(color, 1.0);
    return;
  }

  if (uDebugMode == 1) color = mix(color, hsv2rgb(vec3(fract(float(uCell) * 0.618), 0.6, 0.9)), 0.45);
  if (uDebugMode == 2) color = (uMode != 0 || uGloss > 0.001) ? heatmap(steps / 5.0) : vec3(dot(color, vec3(0.2)));
  if (uDebugMode == 3) color = irr;
  if (uDebugMode == 5) color = texture(uLightmap, vUv2).rgb;

  fragOut = vec4(pow(acesTonemap(color * uExposure), vec3(1.0 / 2.2)), 1.0);
}
`;
}

// ------------------------------------------------------------------ bake shaders

export const FS_TRI_VERT = /* glsl */`in vec2 position;
void main() { gl_Position = vec4(position, 0.0, 1.0); }
`;

// cube face capture -> oct tile (incl. gutter border via extended decode)
export function cubeToOctFrag(numCells) {
  return /* glsl */`precision highp float;
uniform samplerCube uCube;
uniform vec2 uTileOrigin;   // px, bottom-left of the bordered tile
uniform float uTileSize;    // content px
uniform float uFlipX;
out vec4 fragColor;
${atlasGLSL(numCells)}
${OCT_GLSL}
void main() {
  vec2 f = ((gl_FragCoord.xy - uTileOrigin - BORDER_PX) / uTileSize) * 2.0 - 1.0;
  vec3 dir = octDecode(f);
  fragColor = vec4(texture(uCube, vec3(dir.x * uFlipX, dir.y, dir.z)).rgb, 1.0);
}
`;
}

// progressive gaussian-in-angle prefilter: dst lod k reads lod k-1 of uSrc
export function filterFrag(numCells) {
  return /* glsl */`precision highp float;
uniform sampler2D uAtlas;   // source atlas (previous lod complete)
uniform vec2 uTileOrigin;
uniform float uTileSize;
uniform int uSrcLod;
uniform int uCell;
uniform float uAngle;       // filter cone half-angle, radians
out vec4 fragColor;
${atlasGLSL(numCells)}
${OCT_GLSL}
${ATLAS_SAMPLE_GLSL}
void main() {
  vec2 f = ((gl_FragCoord.xy - uTileOrigin - BORDER_PX) / uTileSize) * 2.0 - 1.0;
  vec3 dir = octDecode(f);
  vec3 up = abs(dir.y) < 0.98 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 T = normalize(cross(up, dir));
  vec3 B = cross(dir, T);
  float ta = tan(uAngle);
  vec3 sum = vec3(0.0);
  float wsum = 0.0;
  for (int s = 0; s < 16; s++) {
    float r = sqrt((float(s) + 0.5) / 16.0);
    float a = float(s) * 2.39996;
    vec2 o = vec2(cos(a), sin(a)) * r * ta;
    vec3 sd = normalize(dir + T * o.x + B * o.y);
    float w = exp(-2.0 * r * r);
    sum += w * sampleTile(uCell, uSrcLod, octEncode(sd));
    wsum += w;
  }
  fragColor = vec4(sum / wsum, 1.0);
}
`;
}

// cosine-hemisphere convolution from a mid lod -> irradiance tile (radiance/pi)
export function irrFrag(numCells) {
  return /* glsl */`precision highp float;
uniform sampler2D uAtlas;
uniform vec2 uTileOrigin;
uniform float uTileSize;
uniform int uCell;
out vec4 fragColor;
${atlasGLSL(numCells)}
${OCT_GLSL}
${ATLAS_SAMPLE_GLSL}
void main() {
  vec2 f = ((gl_FragCoord.xy - uTileOrigin - BORDER_PX) / uTileSize) * 2.0 - 1.0;
  vec3 N = octDecode(f);
  vec3 up = abs(N.y) < 0.98 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 T = normalize(cross(up, N));
  vec3 B = cross(N, T);
  vec3 sum = vec3(0.0);
  for (int s = 0; s < 48; s++) {
    float x1 = (float(s) + 0.5) / 48.0;
    float x2 = fract(float(s) * 0.618034);
    float phi = 6.2831853 * x2;
    float st = sqrt(x1);
    float ct = sqrt(1.0 - x1);
    vec3 sd = T * (st * cos(phi)) + B * (st * sin(phi)) + N * ct;
    sum += sampleTile(uCell, 3, octEncode(sd));
  }
  fragColor = vec4(sum / 48.0, 1.0);
}
`;
}

// Irradiance probe grid bake: one draw covers a cell's whole probe block.
// Probe positions come from the grid metadata in the hull texture (clamped
// into the hull); each texel's normal direction is cosine-integrated over the
// hemisphere with the parallax warp applied PER SAMPLE from the probe position
// before lookup — warp-then-convolve, the correct order.
export function probeFrag(numCells) {
  return /* glsl */`precision highp float;
uniform sampler2D uAtlas;    // source atlas (radiance lods complete)
uniform sampler2D uHullTex;
uniform int uCell;
uniform vec2 uBlockOrigin;   // px, bottom-left of this cell's probe block
out vec4 fragColor;
${atlasGLSL(numCells)}
${OCT_GLSL}
${ATLAS_SAMPLE_GLSL}
vec4 hfetch(int cell, int t) { return texelFetch(uHullTex, ivec2(t, cell), 0); }
void main() {
  vec2 local = gl_FragCoord.xy - uBlockOrigin;
  int tx = int(local.x / PROBE_TILE);
  int ty = int(local.y / PROBE_TILE);
  int idx = ty * PROBES_PER_ROW + tx;
  vec4 m0 = hfetch(uCell, ${PROBE_META_OFF});
  vec4 m1 = hfetch(uCell, ${PROBE_META_OFF + 1});
  vec4 m2 = hfetch(uCell, ${PROBE_META_OFF + 2});
  ivec3 dims = ivec3(int(m0.w), int(m1.w), int(m2.x));
  if (idx >= dims.x * dims.y * dims.z) { fragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  int gx = idx % dims.x;
  int gy = (idx / dims.x) % dims.y;
  int gz = idx / (dims.x * dims.y);
  vec3 rel = vec3(
    dims.x > 1 ? float(gx) / float(dims.x - 1) : 0.5,
    dims.y > 1 ? float(gy) / float(dims.y - 1) : 0.5,
    dims.z > 1 ? float(gz) / float(dims.z - 1) : 0.5);
  vec3 probeP = m0.xyz + rel * m1.xyz;
  vec4 h0 = hfetch(uCell, 0);
  int pc = int(h0.w);
  for (int j = 0; j < 12; j++) {          // pull boundary probes inside the hull
    if (j >= pc) break;
    vec4 pl = hfetch(uCell, ${PLANES_OFF} + j);
    float d = dot(pl.xyz, probeP) + pl.w;
    if (d < 0.25) probeP += pl.xyz * (0.25 - d);
  }
  vec2 tileOrigin = uBlockOrigin + vec2(float(tx), float(ty)) * PROBE_TILE;
  vec2 f = ((gl_FragCoord.xy - tileOrigin - BORDER_PX) / PROBE_S) * 2.0 - 1.0;
  vec3 N = octDecode(f);
  vec3 up = abs(N.y) < 0.98 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 T = normalize(cross(up, N));
  vec3 B = cross(N, T);
  vec3 sum = vec3(0.0);
  for (int s = 0; s < 64; s++) {
    float x1 = (float(s) + 0.5) / 64.0;
    float x2 = fract(float(s) * 0.618034);
    float phi = 6.2831853 * x2;
    float st = sqrt(x1);
    float ct = sqrt(1.0 - x1);
    vec3 sd = T * (st * cos(phi)) + B * (st * sin(phi)) + N * ct;
    float bestT = 1e8;
    for (int j = 0; j < 12; j++) {
      if (j >= pc) break;
      vec4 pl = hfetch(uCell, ${PLANES_OFF} + j);
      float dn = dot(pl.xyz, sd);
      if (dn < -1e-5) bestT = min(bestT, -(dot(pl.xyz, probeP) + pl.w) / dn);
    }
    vec3 wdir = probeP + sd * min(bestT, 100.0) - h0.xyz;
    sum += sampleTile(uCell, 2, octEncode(wdir));
  }
  fragColor = vec4(sum / 64.0, 1.0);
}
`;
}

// same-position rect copy between the two atlas ping-pong targets
export const COPY_FRAG = /* glsl */`precision highp float;
uniform sampler2D uSrc;
out vec4 fragColor;
void main() {
  fragColor = texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0);
}
`;
