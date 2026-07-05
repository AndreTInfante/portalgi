// All GLSL for the POC. Scene materials use THREE.ShaderMaterial with GLSL3;
// bake passes use RawShaderMaterial, also GLSL3 (three prepends the version line).
import { atlasGLSL } from './atlas.js';
import { PLANES_OFF, PORTALS_OFF, PORTAL_STRIDE, PROBE_META_OFF, HULL_TEX_W } from './hulldata.js';
import { MAX_OCC_PROPS, MAX_SPHERES, MAX_PER_CELL, MAX_SPH_PER_PROP } from './occluders.js';

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
// NOTE (2026-07-04): a single-tap nearest-LOD sampler was tried for
// secondary hops and blend partials - every use produced a visible artifact
// (mip pop at thresholds, widened-looking blend bands). All atlas samples
// are manual trilinear; the surviving traversal optimization is the
// portal-plane mask, which changes no sampling at all.
vec3 sampleIrr(int cell, vec3 n) {
  vec2 o = octEncode(normalize(n));
  vec2 base = vec2(IRR_X + BORDER_PX, float(cell) * ROW_H + BORDER_PX);
  return texture(uAtlas, (base + o * IRR_S) / ATLAS_SIZE).rgb;
}
// the atlas mips are GGX-prefiltered with roughness linear in mip
float roughToLod(float r) {
  return clamp(r, 0.0, 1.0) * MAX_SPEC_LOD;
}
`;

// portal-hull traversal; hull records come from a std140 uniform block
// (constant-register reads - the dependent texelFetch path is kept as a
// fallback should UniformsGroup misbehave on some driver)
// dbg: compile in the step-count accumulator + debug views. The accumulator
// threads live state through the whole traversal loop - exactly the class of
// register pressure that measurably tipped wave occupancy (see the
// re-emission accumulator note) - so shipping programs compile it OUT.
const traceGlsl = (numCells, useUbo, dbg = false) => /* glsl */`
${useUbo ? /* glsl */`
layout(std140) uniform HullData {
  vec4 uHull[${numCells * HULL_TEX_W}];
};
vec4 hfetch(int cell, int t) { return uHull[cell * ${HULL_TEX_W} + t]; }

// analytic occluders: dynamic props as sphere sets, tested per cell segment
// inside the walk (see occluders.js for the packing)
layout(std140) uniform OccluderData {
  vec4 uOccCell[${numCells}];  // x = first entry, y = count
  vec4 uOccBound[${MAX_OCC_PROPS}];
  vec4 uOccColor[${MAX_OCC_PROPS}]; // rgb albedo; w packs group|count|firstSlot
  vec4 uOccSph[${MAX_SPHERES}];
};
uniform float uOccOn;
uniform float uOccHops;    // LOD: occluders evaluated for the first N cells of the walk
uniform float uOccDensity;
uniform float uOccWiden;   // reflection-cone growth per (roughness * meter)
uniform float uOccTint;    // blocked light re-emits this much occluder diffuse
uniform float uOccAO;      // contact-AO strength from the same capsules
uniform float uOccAOClamp; // AO minimum-distance clamp (m): surfaces never
                           // evaluate closer than capsule surface + this
uniform float uOccShadow;  // dynamic directional shadow strength (capsule shadow rays)
uniform float uOccBudget;  // dynamic-entry CAPSULE budget shared by shadows, AO and
                           // reflection occlusion: dyn casters pack closest-first
                           // and consume budget by capsule count - cost-based, so
                           // six 1-blob gallery props all fit while one 8-blob cart
                           // spends most of it. Statics never spend budget.
uniform float uOccRange;   // dynamic effects exist only within this radius of the
                           // viewer (2m feather; statics are unaffected) - the
                           // budget concentrates where anyone can see it
uniform int uOccSelf;      // occlusion GROUP of the surfaces this material shades:
                           // an occluder never occludes the surfaces it approximates

// closed-form contact AO (Quilez sphere occlusion at the closest axis point):
// the same capsules that occlude reflections darken nearby diffuse. Proxied
// statics are OUT of the lightmap BVH - this is their only shadow, exactly
// one representation per object per lighting domain.
float capsuleAO(int cell, vec3 P, vec3 N, float dynFade) {
  int cnt = int(uOccCell[cell].y);
  if (cnt == 0) return 1.0;
  int first = int(uOccCell[cell].x);
  int dyn = int(uOccCell[cell].z);
  int budget = int(uOccBudget);
  float aoc = 1.0;
  for (int pi = 0; pi < ${MAX_PER_CELL}; pi++) {
    if (pi >= cnt) break;
    vec4 colw = uOccColor[first + pi];
    int packed = int(colw.w + 0.5);
    int sc = (packed >> 6) & 7;
    // dyn entries (packed closest-first) spend the shared capsule budget and
    // fade with viewer distance; statics (furniture - this is their only
    // shadow) always evaluate at full strength
    float k = 1.0;
    if (pi < dyn) {
      budget -= sc;             // spend BEFORE any per-pixel test: the caster
      if (budget < 0) continue; // set must be identical across the cell
      k = dynFade;
      if (k <= 0.0) continue;
    }
    vec4 b = uOccBound[first + pi];
    vec3 dc = b.xyz - P;
    float rb = b.w + 0.7;                        // AO reach beyond the bound
    if (dot(dc, dc) > rb * rb) continue;
    if ((packed & 63) == uOccSelf) continue;     // own-group skip
    int sf = packed >> 9;
    for (int si = 0; si < ${MAX_SPH_PER_PROP}; si++) {
      if (si >= sc) break;
      vec4 A = uOccSph[sf + si * 2];
      vec3 u = uOccSph[sf + si * 2 + 1].xyz - A.xyz;
      float cc = dot(u, u);
      float t = cc > 1e-6 ? clamp(dot(P - A.xyz, u) / cc, 0.0, 1.0) : 0.0;
      vec3 d = A.xyz + u * t - P;                // to the nearest axis point
      // surfaces INSIDE a loose capsule (walls poking through a fit) never
      // evaluate closer than the capsule surface + uOccAOClamp: contact stays
      // strong, interior saturation blotches become impossible (GUI-tunable)
      float d2 = max(dot(d, d), (A.w + uOccAOClamp) * (A.w + uOccAOClamp));
      float invd = inversesqrt(d2);
      float o1 = clamp(dot(N, d * invd), 0.0, 1.0) * (A.w * A.w) / d2;
      // smooth range falloff to zero BEFORE the binary entry reject radius -
      // the reject alone printed a visible AO edge line around objects
      float reach = clamp(1.0 - (d2 * invd - A.w) / 0.6, 0.0, 1.0);
      aoc *= 1.0 - min(o1 * reach * reach * uOccAO, 0.85) * k;
    }
    if (aoc < 0.15) break;
  }
  return aoc;
}

// Directional shadows from DYNAMIC occluders: one ray from P toward the
// luminance/d2-weighted average of the cell's analytic lights (spot cones
// weight by their falloff at P), marched through the PROP capsules only -
// uOccCell.z counts the dynamic entries packed at the head of the cell's
// list. Proxied statics are excluded: their shadows are already baked into
// the lightmap, marching them again would double-darken. Penumbra: the
// capsule radius widens along the ray and coverage dims as r^2/rw^2, so
// small or distant occluders fade out instead of printing hard streaks.
float capsuleShadow(int cell, vec3 P, vec3 N) {
  int dyn = int(uOccCell[cell].z);
  if (dyn == 0) return 1.0;
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= uLightCount) break;
    vec3 L = uLightPos[i] - P;
    float d2 = max(dot(L, L), 0.25);
    float w = dot(uLightColor[i], vec3(0.299, 0.587, 0.114)) / d2;
    if (uLightDir[i].w > -1.5) {
      w *= smoothstep(uLightDir[i].w, uLightDir[i].w + 0.08,
                      dot(normalize(-L), uLightDir[i].xyz));
    }
    acc += w * L;
    wsum += w;
  }
  if (wsum < 1e-5) return 1.0;
  vec3 toL = acc / wsum;
  float len = max(length(toL), 1e-4);
  vec3 dir = toL / len;
  // facing fade on the GEOMETRIC normal (callers must not pass the bumped
  // one): a binary gate on the normal-mapped N punched bright pinpricks
  // through shadows wherever a bump facet tilted past the threshold
  float face = smoothstep(0.0, 0.2, dot(N, dir));
  if (face <= 0.0) return 1.0;
  // 3m cap: coverage dims to ~0.13 by then (r^2/rw^2), invisible - and the
  // shorter segment lets the per-entry bound test reject far more pixels
  // (the shadow march measured ~2ms at 125->85u; this is the cheap half)
  float span = min(len, 3.0);
  int first = int(uOccCell[cell].x);
  // single-ray visibility: overlapping volumes block the light ONCE - take
  // the MAX coverage over capsules, not the product (the product printed
  // extra darkening wherever authored capsules overlap)
  float occl = 0.0;
  int budget = int(uOccBudget);
  for (int pi = 0; pi < ${MAX_PER_CELL}; pi++) {
    if (pi >= dyn) break;
    // capsule-count budget, spent CLOSEST-FIRST and BEFORE the per-pixel
    // bound reject: the caster set must be identical for every pixel in the
    // cell or shadows would pop at reject boundaries
    vec4 colw = uOccColor[first + pi];
    int packed = int(colw.w + 0.5);
    int sc = (packed >> 6) & 7;
    budget -= sc;
    if (budget < 0) break;
    vec4 b = uOccBound[first + pi];
    vec3 dc = b.xyz - P;
    float tb = clamp(dot(dc, dir), 0.0, span);
    vec3 q = dc - dir * tb;
    float rb = b.w + 0.6;                        // penumbra margin
    if (dot(q, q) > rb * rb) continue;
    if ((packed & 63) == uOccSelf) continue;     // own-group skip
    int sf = packed >> 9;
    for (int si = 0; si < ${MAX_SPH_PER_PROP}; si++) {
      if (si >= sc) break;
      vec4 A = uOccSph[sf + si * 2];
      vec3 u = uOccSph[sf + si * 2 + 1].xyz - A.xyz;
      // closest approach of the shadow ray to the capsule axis (clamped)
      vec3 w0 = P - A.xyz;
      float bb = dot(dir, u);
      float cc = max(dot(u, u), 1e-8);
      float dd = dot(dir, w0);
      float ee = dot(u, w0);
      float den = cc - bb * bb;
      float s = den > 1e-6 ? clamp((bb * ee - cc * dd) / den, 0.0, span) : 0.0;
      float t = clamp((bb * s + ee) / cc, 0.0, 1.0);
      s = clamp(bb * t - dd, 0.0, span);
      vec3 dv = (P + dir * s) - (A.xyz + u * t);
      float dist = length(dv);
      float rw = A.w + s * 0.12;                 // ~7deg effective source size
      float pen = clamp((rw - dist) / max(rw * 0.45, 1e-3), 0.0, 1.0);
      // near-contact RAMP, not a hard skip: the binary skip printed a bright
      // pinprick in the middle of the shadow wherever a prop nearly touched
      // the receiver. Contact AO owns the contact zone; hand off smoothly.
      pen *= smoothstep(0.0, 0.12, s);
      occl = max(occl, pen * min(1.0, (A.w * A.w) / (rw * rw)));
    }
    if (occl > 0.95) break;
  }
  return 1.0 - occl * face * uOccShadow;
}

// transmittance through this cell's occluders (CAPSULES: two vec4 slots,
// (a,r)+(b,-); a==b is a sphere) along ray segment [0, tMax].
// Falloff is cone-footprint coverage: the reflection cone grows with
// surface roughness x distance, and a blurred occluder spreads its
// occlusion over the widened radius with a dimmed peak (r^2/rw^2) - energy
// conserving. Chrome (rough~0) sees solid occluders with feathered edges at
// any distance; rough floors see them fade out with distance.
// Subtractive and saturating - no sorting. Each bite of transmittance
// accumulates the biter's albedo into col so the caller can re-emit blocked
// light as darkened occluder diffuse instead of pitch black.
float occSegment(int cell, vec3 o, vec3 d, float tMax, float rough, float tBase, float dynFade, inout vec3 col) {
  float trans = 1.0;
  int cnt = int(uOccCell[cell].y);
  if (cnt == 0) return trans;
  int first = int(uOccCell[cell].x);
  int dyn = int(uOccCell[cell].z);
  int budget = int(uOccBudget);
  // low-end knee: GGX blur is strongly nonlinear at small roughness (alpha ~
  // rough^2), so near-mirror surfaces (chrome/glass ~0.04) widen almost
  // nothing - linear widening made their blobs ghostly-faint while their
  // reflection image stayed crisp. Mid-rough floors (>= 0.15) are unchanged.
  float wr = rough * clamp(rough * 6.667, 0.0, 1.0);
  for (int pi = 0; pi < ${MAX_PER_CELL}; pi++) {
    if (pi >= cnt) break;
    vec4 colw = uOccColor[first + pi];
    int packed = int(colw.w + 0.5);
    int sc = (packed >> 6) & 7;
    // dyn prefix: shared closest-first capsule budget + viewer-distance fade;
    // statics (furniture reflections - captures exclude them) always march
    float k = 1.0;
    if (pi < dyn) {
      budget -= sc;
      if (budget < 0) continue;
      k = dynFade;
      if (k <= 0.0) continue;
    }
    vec4 b = uOccBound[first + pi];
    vec3 oc = b.xyz - o;
    float tc = clamp(dot(oc, d), 0.0, tMax);
    vec3 pc = oc - d * tc;
    float rb = b.w + uOccWiden * wr * (tBase + tc) + 0.05;
    if (dot(pc, pc) > rb * rb) continue;          // entry-level reject
    if ((packed & 63) == uOccSelf) continue;      // own-group skip
    int sf = packed >> 9;
    for (int si = 0; si < ${MAX_SPH_PER_PROP}; si++) {
      if (si >= sc) break;
      vec4 A = uOccSph[sf + si * 2];
      vec3 u = uOccSph[sf + si * 2 + 1].xyz - A.xyz;
      // closest approach between the ray segment and the capsule axis
      vec3 w0 = o - A.xyz;
      float bb = dot(d, u);
      float cc = dot(u, u);
      float dw = dot(d, w0);
      float e = dot(u, w0);
      float sg = cc > 1e-6 ? clamp((e - dw * bb) / max(cc - bb * bb, 1e-5), 0.0, 1.0) : 0.0;
      float ts = clamp(sg * bb - dw, 0.0, tMax);
      if (cc > 1e-6) sg = clamp((e + ts * bb) / cc, 0.0, 1.0);
      vec3 ps = w0 + d * ts - u * sg;
      float rw = A.w + uOccWiden * wr * (tBase + ts);
      float q = 1.0 - dot(ps, ps) / (rw * rw);    // 0 at the widened silhouette
      if (q <= 0.0) continue;
      float cover = (A.w * A.w) / (rw * rw);      // blur spreads, peak dims
      float taken = trans * clamp(uOccDensity * q * cover, 0.0, 1.0) * k;
      trans -= taken;
      col += taken * colw.rgb;
    }
    if (trans < 0.01) break;
  }
  return trans;
}
` : /* glsl */`
uniform sampler2D uHullTex;
vec4 hfetch(int cell, int t) { return texelFetch(uHullTex, ivec2(t, cell), 0); }
`}
uniform int uMaxSteps;      // portal hops allowed; 0 = plain parallax-corrected cubemap
uniform float uRoughHops;   // 1 = scale the hop budget by surface roughness
uniform float uBlendOn;
uniform float uBlendBase;   // blend band width floor, meters
uniform float uBlendRough;  // blend band growth per (roughness * meter)
uniform float uDistRough;   // roughness growth per meter of path length

// Walk the reflection ray through the convex-cell graph.
// Each iteration: analytic ray-vs-hull exit, portal lookup on the exit plane,
// roughness-scaled edge blend, then either terminate on the local cubemap or
// hop into the neighbor cell. A straight ray can never revisit a convex cell,
// so this always makes forward progress.
vec3 traceSpec(int cell, vec3 pos, vec3 dir, float rough, int hopCap, float dynFade${dbg ? ', out float stepsUsed' : ''}) {
  // roughness-scaled hop budget: a reflection too blurry to resolve an image
  // can't resolve a second portal either. Anything reflective keeps >= 1 hop
  // (portal-boundary artifacts appear at 0); the rough > 0.65 irradiance
  // early-out at the call site is the 0-hop rung of the same ladder.
  // hopCap: callers whose contribution is faint (glass fresnel reflection,
  // ~4-10% of the mix) cap their depth instead of paying the full budget.
  int maxHops = min(uMaxSteps, hopCap);
  if (uRoughHops > 0.5) {
    if (rough > 0.35) maxHops = min(uMaxSteps, 1);
    else if (rough > 0.12) maxHops = min(uMaxSteps, 2);
  }
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
  ${dbg ? 'stepsUsed = 0.0;' : ''}
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
${useUbo ? /* glsl */`
    // occluder transmittance over this cell's segment attenuates everything
    // sampled beyond it (this cell's tile AND the recursion); the blocked
    // fraction re-emits as darkened occluder diffuse lit by cell irradiance
    if (uOccOn > 0.5 && float(i) < uOccHops) {
      vec3 ocol = vec3(0.0);
      // surface roughness (not distance-grown effR) drives the cone: the
      // footprint model already accounts for distance inside occSegment
      float tr = occSegment(cell, pos, dir, bestT, rough, tTot, dynFade, ocol);
      // tinted re-emission taps irradiance only at PERCEPTIBLE occlusion
      // (>= 5%; the old 0.3% threshold bought an extra atlas fetch across
      // every faintly-grazed pixel of cone-widened blob area). Kept per-hop:
      // an accumulator threaded through the walk cost registers on every
      // traceSpec in every pixel and tipped occupancy (measured regression)
      if (tr < 0.95) acc += w * uOccTint * ocol * sampleIrr(cell, -dir);
      w *= tr;
      if (w < 0.005) return acc;
    }
` : ''}
    int nextCell = -1;
    float blend = 0.0;
    // the portal-plane bitmask skips the whole scan when the exit plane
    // carries no portal - the common case for every glossy pixel
    if (i < maxHops && bestPlane >= 0) {
      vec4 h1 = hfetch(cell, 1);
      if ((int(h1.w) & (1 << bestPlane)) != 0) {
      int poc = int(h1.x);
      for (int p = 0; p < 4; p++) {
        if (p >= poc) break;
        int base = ${PORTALS_OFF} + p * ${PORTAL_STRIDE};
        vec4 ph = hfetch(cell, base);
        if (int(ph.x) != bestPlane) continue;
        // ph.w is a per-edge bitmask: bit e set = SILHOUETTE edge (geometry
        // beyond it breaks the portal plane - pillar corner, doorframe). There
        // the actual content sits at the plane, so the local flat sample is
        // parallax-exact and blending gives cone-footprint anti-aliasing of
        // the partition. Unset = CONTINUATION edge (the neighbor has a
        // coplanar surface crossing the edge - floor under a cut, a shared
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
          // edge blending at EVERY crossing: restricting it to the first hop
          // made the seam treatment depend on which cell the shaded surface
          // belongs to - a visible side-dependent gap when walking through
          // doorway-through-doorway views (in-headset report). The deep
          // partial samples stay single-tap, so this costs half its original
          // price.
          float bw = uBlendBase + uBlendRough * effR * max(tHit, 0.3);
          blend = (uBlendOn < 0.5) ? 1.0 : clamp(blendD / bw, 0.0, 1.0);
          nextCell = int(ph.y);
          break;
        }
      }
      }
    }
    vec3 localDir = hitP - h0.xyz;
    if (nextCell < 0 || blend <= 0.002) {
      // the terminal sample is directly visible content: always trilinear.
      // (Nearest-LOD here popped between mip columns as reflections crossed
      // portal thresholds - fidelity discontinuity right at the seam.)
      acc += w * sampleSpec(cell, localDir, lod);
      return acc;
    }
    if (blend < 0.998) {
      acc += w * (1.0 - blend) * sampleSpec(cell, localDir, lod);
      w *= blend;
    }
    ${dbg ? 'stepsUsed += 1.0;' : ''}
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
// is a true 50/50, identical no matter which side shades the point - C0 in
// space for static seams AND in time when a prop's cell assignment flips.
// (A 0.5 weight normalizes to 2/3 self + 1/3 neighbor, which pops by
// (A-B)/3 at the flip - the classic asymmetric-blend mistake.)
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
attribute vec2 lmuv;   // lightmap charts; absent on props (disabled attr reads 0)
attribute vec4 tang4;  // tangent xyz + handedness w (custom name: see lmuv note)
varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec4 vTan;
varying vec2 vUv;
varying vec2 vUv2;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vTan = vec4(normalize(mat3(modelMatrix) * tang4.xyz), tang4.w);
  vUv = uv;
  vUv2 = lmuv;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

// One PRUNED program per material mode (0 static, 2 glass, 3 pane, 4 prop):
// the uber-shader ran every pixel at worst-case register pressure (52% wave
// occupancy measured on-device) for code paths it could never take. Unused
// helper functions are stripped by the GLSL compiler once the CALLS are
// template-removed. Statics compile their pre-lightmap fallback only under
// the LM_FALLBACK define (materials toggle it with the lightmap state).
// matte: guaranteed-rough statics (min roughness x factor > 0.65 across the
// whole ORM set) ALWAYS take the irradiance early-out, so their program
// compiles with no traversal at all. Register allocation is static per
// program - without this, wall/ceiling pixels (most fill) ran at
// glossy-floor occupancy to execute one irradiance tap.
export function sceneFrag(numCells, useUbo = true, mode = 0, dbg = false, matte = false) {
  const STATIC = mode === 0, PROP = mode === 4, GLASS = mode === 2, PANE = mode === 3;
  return /* glsl */`
precision highp float;
layout(location = 0) out vec4 fragOut;
varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec4 vTan;
varying vec2 vUv;
varying vec2 vUv2;

uniform sampler2D uAtlas;
uniform sampler2D uMap;
uniform sampler2D uNrmMap;
uniform sampler2D uOrmMap;   // AO / roughness / metallic
uniform float uRoughFactor;
uniform float uMetalFactor;
uniform float uSpecBoost;
uniform sampler2D uLightmap;
uniform float uUseLightmap;
uniform int uCell;
uniform int uCellPrev;    // previous cell during a diffuse handoff crossfade (-1 = none)
uniform float uPrevMix;   // crossfade weight of the previous cell, decays over ~0.2s
uniform int uMode;        // 0 = surface, 1 = chrome, 2 = glass, 3 = debug pane, 4 = dynamic diffuse (parallax-corrected irradiance)
uniform vec3 uTint;
uniform vec3 uEmissive;
uniform float uRough;
uniform vec3 uLightPos[8];
uniform vec3 uLightColor[8]; // premultiplied by intensity (and crossing weight, for props)
uniform vec4 uLightDir[8];   // spot axis + cos(outer); w = -2 -> point light
uniform int uLightCount;
uniform float uBake;
uniform float uExposure;
uniform int uDebugMode;   // 0 off, 1 cell tint, 2 step heatmap, 3 irradiance, 4 white world

${atlasGLSL(numCells)}
${OCT_GLSL}
${ATLAS_SAMPLE_GLSL}
${traceGlsl(numCells, useUbo, dbg)}
${TONEMAP_GLSL}

// Diffuse for dynamic objects: per-cell irradiance PROBE GRID, trilinear over
// 8 probes. Each probe was convolved at bake time from its own position with
// the parallax warp applied to the radiance BEFORE the cosine convolution -
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
    sum += uLightColor[i] * (max(dot(N, L), 0.0) / max(d2, 0.05)); // true inverse-square
  }
  return sum;
}

// Karis' analytic environment BRDF approximation (mobile split-sum)
vec3 envBRDF(vec3 F0, float rough, float NoV) {
  const vec4 c0 = vec4(-1.0, -0.0275, -0.572, 0.022);
  const vec4 c1 = vec4(1.0, 0.0425, 1.04, -0.04);
  vec4 r = rough * c0 + c1;
  float a004 = min(r.x * r.x, exp2(-9.28 * NoV)) * r.x + r.y;
  vec2 AB = vec2(-1.04, 1.04) * a004 + r.zw;
  return F0 * AB.x + AB.y;
}

void main() {
  vec3 P = vWorldPos;
  vec3 Ng = normalize(vNormal);
  if (!gl_FrontFacing) Ng = -Ng;
  vec3 V = normalize(cameraPosition - P);

  // tangent-space normal mapping (specular + probe response; the flat lightmap
  // itself is non-directional for now). Geometries without tangents (primitive
  // props) read a zero attribute - guard against normalize(0) = NaN.
  vec3 N = Ng;
  vec3 Traw = vTan.xyz - Ng * dot(Ng, vTan.xyz);
  float tLen = length(Traw);
  if (tLen > 1e-4) {
    vec3 T = Traw / tLen;
    vec3 B = cross(Ng, T) * vTan.w;
    vec3 nTS = texture(uNrmMap, vUv).xyz * 2.0 - 1.0;
    N = normalize(T * nTS.x + B * nTS.y + Ng * nTS.z);
  }
  float NoV = max(dot(N, V), 0.0);
  ${dbg ? 'float steps = 0.0;' : ''}
${useUbo ? /* glsl */`
  // dynamic-occluder effects (contact AO, shadow rays, reflection blobs)
  // exist only within uOccRange of the viewer, feathered over 2m - the
  // capsule budget concentrates where anyone can see it. Statics never fade.
  float dynFade = 1.0 - smoothstep(uOccRange - 2.0, uOccRange, distance(P, cameraPosition));
` : 'float dynFade = 1.0;'}
  vec3 color;
${GLASS ? /* glsl */`
  // glass: chrome sampled the opposite way. The fresnel reflection is a
  // faint overlay over the dominant fake refraction: 1 hop is plenty for it
  vec3 R = reflect(-V, N);
  float F = 0.04 + 0.96 * pow(1.0 - NoV, 5.0);
  vec3 refl = traceSpec(uCell, P, R, uRough, 1, dynFade${dbg ? ', steps' : ''});
  ${dbg ? 'float s2;' : ''}
  vec3 thru = traceSpec(uCell, P, -R, uRough + 0.03, 8, dynFade${dbg ? ', s2' : ''}) * vec3(0.90, 0.97, 0.93);
  color = mix(thru, refl, F);
` : PANE ? /* glsl */`
  // debug pane: continue the eye ray straight through with zero roughness -
  // a direct, unrefracted window into the hull cubemap structure (a -R trick
  // here would mirror the lateral ray component and act like an inverting
  // lens). Faint green cast marks the glass.
  color = traceSpec(uCell, P, -V, 0.0, 8, dynFade${dbg ? ', steps' : ''}) * vec3(0.93, 1.0, 0.96);
` : /* glsl */`
  vec3 albedo = texture(uMap, vUv).rgb * uTint;
  ${dbg ? 'if (uDebugMode == 4) albedo = vec3(0.75);' : ''}
  vec3 orm = texture(uOrmMap, vUv).rgb;
  float rough = clamp(orm.g * uRoughFactor, 0.03, 1.0);
  float metal = clamp(orm.b * uMetalFactor, 0.0, 1.0);
  float ao = orm.r;
  vec3 diffuseL;
${PROP ? /* glsl */`
  // probe-grid irradiance with the 0.2s cell-handoff crossfade
  diffuseL = probeDiffuse(uCell, P, N);
  if (uPrevMix > 0.001 && uCellPrev >= 0) {
    diffuseL = mix(diffuseL, probeDiffuse(uCellPrev, P, N), uPrevMix);
  }
  // analytic SPOT direct on props: the probe grid averages a room's light but
  // cannot represent a narrow beam, so props in a spotlight stayed flat.
  // Point lights (w = -2) skip - their energy is already in the probes. Cone
  // math matches the lightmapper's (soft 0.08-cos shoulder), unshadowed.
  for (int li = 0; li < 8; li++) {
    if (li >= uLightCount) break;
    if (uLightDir[li].w < -1.5) continue;
    vec3 Lv = uLightPos[li] - P;
    float ld2 = dot(Lv, Lv);
    vec3 Lnn = Lv * inversesqrt(ld2);
    float ndl = dot(N, Lnn);
    if (ndl <= 0.0) continue;
    float spot = smoothstep(uLightDir[li].w, uLightDir[li].w + 0.08, dot(-Lnn, uLightDir[li].xyz));
    diffuseL += uLightColor[li] * (spot * ndl / max(ld2, 0.05));
  }
` : /* glsl */`
#ifdef LM_FALLBACK
  // pre-lightmap boot / lightmap-off debug: analytic lights + cross-portal
  // blended irradiance (compiled in only while actually needed - it is ~25
  // fetches of register pressure otherwise)
  diffuseL = directLight(P, N) + blendedIrr(uCell, P, N);
#else
  diffuseL = texture(uLightmap, vUv2).rgb;
#endif
`}
${useUbo ? /* glsl */`
  // live contact AO from the occluder capsules (props AND proxied statics -
  // the statics cast nothing in the lightmap by design; dyn entries fade
  // with dynFade inside)
  if (uOccOn > 0.5) {
    diffuseL *= capsuleAO(uCell, P, N, dynFade);
    // dynamic directional shadows: one capsule-marched ray toward the
    // weighted local light direction ("we have raytracing at home").
    // Ng, NOT the bumped N: bump facets tilting past a facing gate punched
    // bright acne pinpricks through the shadow interior
    if (uOccShadow > 0.001 && dynFade > 0.0) {
      diffuseL *= mix(1.0, capsuleShadow(uCell, P, Ng), dynFade);
    }
  }
` : ''}
  vec3 F0 = mix(vec3(0.04), albedo, metal);
  color = albedo * (1.0 - metal) * ao * diffuseL + uEmissive;
  ${STATIC ? 'if (uBake < 0.5) {' : '{'}  // split-sum: prefiltered radiance - env BRDF
    vec3 R = reflect(-V, N);
    // very rough surfaces (most wall/ceiling area): the traversal's max-lod
    // result is indistinguishable from one cosine-convolved irradiance tap
    // along R - skip the whole hull walk (Tier 1)
    vec3 pre = ${matte ? 'sampleIrr(uCell, R)'
      : `(rough > 0.65) ? sampleIrr(uCell, R)
                              : traceSpec(uCell, P, R, rough, 8, dynFade${dbg ? ', steps' : ''})`};
    color += pre * envBRDF(F0, rough, NoV) * ao * uSpecBoost;
  }
`}
${STATIC ? /* glsl */`
  if (uBake > 0.5) {                     // HDR capture pass: linear, no tonemap
    fragOut = vec4(color, 1.0);
    return;
  }
` : ''}
${dbg ? /* glsl */`
${STATIC ? `
  if (uDebugMode == 3) color = sampleIrr(uCell, N);
  if (uDebugMode == 5) color = texture(uLightmap, vUv2).rgb;
` : ''}
  if (uDebugMode == 1) color = mix(color, hsv2rgb(vec3(fract(float(uCell) * 0.618), 0.6, 0.9)), 0.45);
  if (uDebugMode == 2) color = heatmap(steps / 5.0);
` : ''}
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

// GGX-prefiltered specular mips (split-sum convention): each mip k targets
// roughness k/maxLod, importance-sampling GGX around N=V=R with NoL weighting
// (Karis). Reads a slightly-blurred lower mip as variance reduction (filtered
// importance sampling).
export function filterFrag(numCells) {
  return /* glsl */`precision highp float;
uniform sampler2D uAtlas;   // source atlas (lower lods complete)
uniform vec2 uTileOrigin;
uniform float uTileSize;
uniform int uSrcLod;
uniform int uCell;
uniform float uRough;       // target roughness for this mip
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
  float a = max(uRough * uRough, 2e-3);
  vec3 sum = vec3(0.0);
  float wsum = 0.0;
  for (int s = 0; s < 40; s++) {
    float x1 = (float(s) + 0.5) / 40.0;
    float x2 = fract(float(s) * 0.618034);
    float phi = 6.2831853 * x2;
    float ct = sqrt((1.0 - x1) / (1.0 + (a * a - 1.0) * x1));
    float st = sqrt(max(1.0 - ct * ct, 0.0));
    vec3 H = T * (st * cos(phi)) + B * (st * sin(phi)) + N * ct;
    vec3 L = 2.0 * dot(N, H) * H - N;
    float NoL = dot(N, L);
    if (NoL <= 0.0) continue;
    sum += sampleTile(uCell, uSrcLod, octEncode(L)) * NoL;
    wsum += NoL;
  }
  fragColor = vec4(wsum > 0.0 ? sum / wsum : sampleTile(uCell, uSrcLod, octEncode(N)), 1.0);
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
// before lookup - warp-then-convolve, the correct order.
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
