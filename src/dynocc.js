// Texture-space dynamic occlusion: contact AO and
// capsule shadows are LOW-FREQUENCY signals over STATIC receivers
// evaluated once per lightmap texel into a small occlusion layer over
// the lightmap UV space, instead of per stereo-MSAA fragment per frame.
// Scene shaders read the answer with one bilinear tap
// (diffuseL *= texture(uDynOcc, vUv2).r), which deletes both capsule loops -
// and their register footprint - from every static program, matte included.
// Cost scales with layer texels, not screen pixels: the view-range/pop-in
// gating becomes unnecessary here, and shadows/AO stop clipping at portal
// planes by construction (the splat is global world-space - no cells).
//
// Split of duties:
//   base layer  (load time): STATIC proxies' AO, with occlusion-group skip
//                            (a bench must not AO the seat it approximates)
//   dyn layer   (per frame): dynamic props' AO x shadow over the baseline.
//                            NO group logic at all - props never approximate
//                            static receivers.
//   props       (eye space): the analytic loops run in the PROP program
//                            only; props have no lightmap UVs and are a
//                            small fraction of fill.
// Shadow directions come from the CPU, one per prop (weighted average of its
// cell's lights at the CASTER), deleting the per-pixel 8-light loop and, as
// a side effect, the shadow-direction snap at portal crossings (the direction
// follows the caster, not the receiver's cell).
import * as THREE from 'three';

const MAX_ENT = 16;   // entries per splat pass (statics run multiple passes)
const MAX_CAPS = 64;  // vec4 pairs across the pass's entries

const GBUF_VERT = /* glsl */`
attribute vec2 lmuv;
varying vec3 vPos;
varying vec3 vNrm;
void main() {
  vPos = (modelMatrix * vec4(position, 1.0)).xyz;
  vNrm = normalize(mat3(modelMatrix) * normal);
  gl_Position = vec4(lmuv * 2.0 - 1.0, 0.0, 1.0);
}`;

// NOTE: three's GLSL3 ShaderMaterial path provides NO gl_FragColor compat
// define - each fragment shader declares its own out (sceneFrag does too)
const GBUF_FRAG = /* glsl */`
precision highp float;
layout(location = 0) out vec4 oCol;
varying vec3 vPos;
varying vec3 vNrm;
uniform float uWhich; // 0 = position, 1 = normal + occlusion group in alpha
uniform float uGroup;
void main() {
  oCol = uWhich < 0.5 ? vec4(vPos, 1.0) : vec4(normalize(vNrm), uGroup);
}`;

// capsule contact AO: Quilez sphere occlusion at the nearest axis point,
// interior distance clamp, smooth reach falloff - the same math as the
// eye-space capsuleAO loop, on the GEOMETRIC normal (quarter-res texels
// can't resolve bump facets anyway)
const AO_BODY = /* glsl */`
float capAO(vec3 P, vec3 N, vec4 A, vec3 Bp, float aoK, float aoClamp) {
  vec3 u = Bp - A.xyz;
  float cc = dot(u, u);
  float t = cc > 1e-6 ? clamp(dot(P - A.xyz, u) / cc, 0.0, 1.0) : 0.0;
  vec3 d = A.xyz + u * t - P;
  float d2 = max(dot(d, d), (A.w + aoClamp) * (A.w + aoClamp));
  float invd = inversesqrt(d2);
  float o1 = clamp(dot(N, d * invd), 0.0, 1.0) * (A.w * A.w) / d2;
  float reach = clamp(1.0 - (d2 * invd - A.w) / 0.6, 0.0, 1.0);
  return 1.0 - min(o1 * reach * reach * aoK, 0.85);
}`;

// load-time baseline: static proxies' AO with the own-group skip (receiver
// group rides the normal G-buffer's alpha). Multiplicative blending
// accumulates batches of MAX_ENT entries into one white-cleared target.
const BASE_FRAG = /* glsl */`
precision highp float;
layout(location = 0) out vec4 oCol;
uniform sampler2D uPosG;
uniform sampler2D uNrmG;
uniform int uNEnt;
uniform vec4 uEntB[${MAX_ENT}];  // bound sphere
uniform vec4 uEntM[${MAX_ENT}];  // firstCap, capCount, group, -
uniform vec4 uCapA[${MAX_CAPS}];
uniform vec4 uCapB[${MAX_CAPS}];
uniform float uAO, uAOClamp;
${AO_BODY}
void main() {
  ivec2 tx = ivec2(gl_FragCoord.xy);
  vec4 pw = texelFetch(uPosG, tx, 0);
  if (pw.a < 0.5) { oCol = vec4(1.0); return; } // gutters: dilated after
  vec3 P = pw.xyz;
  vec4 ng = texelFetch(uNrmG, tx, 0);
  float aoc = 1.0;
  for (int e = 0; e < ${MAX_ENT}; e++) {
    if (e >= uNEnt) break;
    if (ng.a > 0.5 && abs(uEntM[e].z - ng.a) < 0.5) continue; // own-group skip
    vec4 b = uEntB[e];
    vec3 dc = b.xyz - P;
    float rb = b.w + 0.7;
    if (dot(dc, dc) > rb * rb) continue;
    int first = int(uEntM[e].x), cnt = int(uEntM[e].y);
    for (int si = 0; si < 8; si++) {
      if (si >= cnt) break;
      aoc *= capAO(P, ng.xyz, uCapA[first + si], uCapB[first + si].xyz, uAO, uAOClamp);
    }
  }
  oCol = vec4(aoc, aoc, aoc, 1.0);
}`;

// per-frame: dynamic props' AO x shadow over the baseline. Shadow direction
// and span arrive per ENTRY from the CPU; occlusion takes the MAX across one
// entry's capsules (single-ray visibility: one blocker blocks once) and
// MULTIPLIES across entries (independent casters, each with its own light
// direction).
const DYN_FRAG = /* glsl */`
precision highp float;
layout(location = 0) out vec4 oCol;
uniform sampler2D uPosG;
uniform sampler2D uNrmG;
uniform sampler2D uBase;
uniform int uNEnt;
uniform vec4 uEntB[${MAX_ENT}];  // bound sphere
uniform vec4 uEntM[${MAX_ENT}];  // firstCap, capCount, -, -
uniform vec4 uEntD[${MAX_ENT}];  // shadow dir xyz, span (0 = no shadow)
uniform vec4 uCapA[${MAX_CAPS}];
uniform vec4 uCapB[${MAX_CAPS}];
uniform float uAO, uAOClamp, uShadow;
uniform float uPenSoft; // penumbra width floor (m) ~ 1.5 layer texels: the
                        // quarter-res grid cannot represent a harder edge.
                        // Band-limit the SIGNAL: sub-texel shadows dim out.
${AO_BODY}
void main() {
  ivec2 tx = ivec2(gl_FragCoord.xy);
  float base = texelFetch(uBase, tx, 0).r;
  vec4 pw = texelFetch(uPosG, tx, 0);
  if (pw.a < 0.5) { oCol = vec4(base, base, base, 1.0); return; }
  vec3 P = pw.xyz;
  vec3 N = texelFetch(uNrmG, tx, 0).xyz;
  float aoc = 1.0;
  float shad = 1.0;
  for (int e = 0; e < ${MAX_ENT}; e++) {
    if (e >= uNEnt) break;
    vec4 b = uEntB[e];
    vec3 dc = b.xyz - P;
    float rb = b.w + 3.2; // covers AO reach AND the 3m shadow span
    if (dot(dc, dc) > rb * rb) continue;
    int first = int(uEntM[e].x), cnt = int(uEntM[e].y);
    if (dot(dc, dc) < (b.w + 0.7) * (b.w + 0.7)) {
      for (int si = 0; si < 8; si++) {
        if (si >= cnt) break;
        aoc *= capAO(P, N, uCapA[first + si], uCapB[first + si].xyz, uAO, uAOClamp);
      }
    }
    vec3 dir = uEntD[e].xyz;
    float span = uEntD[e].w;
    float face = smoothstep(0.0, 0.2, dot(N, dir));
    if (span > 0.0 && face > 0.0 && uShadow > 0.001) {
      float occl = 0.0;
      for (int si = 0; si < 8; si++) {
        if (si >= cnt) break;
        // closest approach of the shadow ray to the capsule axis (clamped),
        // penumbra widening + r^2/rw^2 coverage dimming, near-contact ramp -
        // all identical to the eye-space capsuleShadow
        vec4 A = uCapA[first + si];
        vec3 u = uCapB[first + si].xyz - A.xyz;
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
        float rw = A.w + s * 0.12;
        // transition width floored at uPenSoft: when the floor exceeds rw,
        // pen peaks below 1 - a shadow narrower than a texel LOSES energy
        // instead of aliasing (correct prefiltering, not just blur)
        float pen = clamp((rw - dist) / max(max(rw * 0.45, uPenSoft), 1e-3), 0.0, 1.0);
        pen *= smoothstep(0.0, 0.12, s); // contact handoff to AO
        occl = max(occl, pen * min(1.0, (A.w * A.w) / (rw * rw)));
      }
      shad *= 1.0 - occl * face * uShadow;
    }
  }
  float v = base * aoc * shad;
  oCol = vec4(v, v, v, 1.0);
}`;

// flood uncovered texels (chart gutters at layer resolution) from covered
// neighbors so bilinear taps at chart borders never mix toward blank white
const DILATE_FRAG = /* glsl */`
precision highp float;
layout(location = 0) out vec4 oCol;
uniform sampler2D uSrc;
uniform sampler2D uPosG; // coverage mask
void main() {
  ivec2 tx = ivec2(gl_FragCoord.xy);
  if (texelFetch(uPosG, tx, 0).a > 0.5) {
    oCol = vec4(texelFetch(uSrc, tx, 0).r);
    return;
  }
  float sum = 0.0, n = 0.0;
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      ivec2 q = tx + ivec2(dx, dy);
      if (texelFetch(uPosG, q, 0).a > 0.5) { sum += texelFetch(uSrc, q, 0).r; n += 1.0; }
    }
  }
  oCol = vec4(n > 0.0 ? sum / n : 1.0);
}`;

export class DynOccLayer {
  // staticGroup: the charted static meshes (they carry lmuv + world
  // transforms + their material's occlusion group in uOccSelf). Construct
  // AFTER the occluder system has assigned every static group id.
  // div: layer density divisor vs the lightmap (2 = half, 4 = quarter -
  // platform-chosen in main.js; sweeping shadows crawl at quarter res)
  constructor(renderer, level, staticGroup, div = 4) {
    this.renderer = renderer;
    const [lw, lh] = level.lightmapSize;
    this.w = Math.max(64, Math.floor(lw / div));
    this.h = Math.max(64, Math.floor(lh / div));
    const rt = (type, filter) => new THREE.WebGLRenderTarget(this.w, this.h, {
      type, minFilter: filter, magFilter: filter,
      generateMipmaps: false, depthBuffer: false,
    });
    // positions stay fp32 (contact AO clamps at 3cm - fp16's ~4cm error at
    // room scale is too coarse); normals + group ids are fp16-exact
    this.posRT = rt(THREE.FloatType, THREE.NearestFilter);
    this.nrmRT = rt(THREE.HalfFloatType, THREE.NearestFilter);
    this.baseRT = rt(THREE.UnsignedByteType, THREE.NearestFilter);
    this.layerRT = rt(THREE.UnsignedByteType, THREE.LinearFilter);
    this.spareRT = rt(THREE.UnsignedByteType, THREE.NearestFilter);
    this.cam = new THREE.Camera();

    // UV-space G-buffer of the static receivers, rendered once: one gbuf
    // material INSTANCE per mesh (same program) so uGroup varies per mesh
    const gscene = new THREE.Scene();
    for (const m of staticGroup.children) {
      const mat = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3, // texelFetch consumers; three #defines the
        vertexShader: GBUF_VERT, fragmentShader: GBUF_FRAG, // ESSL1 keywords
        uniforms: {
          uWhich: { value: 0 },
          uGroup: { value: (m.material.uniforms && m.material.uniforms.uOccSelf)
            ? Math.max(0, m.material.uniforms.uOccSelf.value) : 0 },
        },
        depthTest: false, depthWrite: false,
      });
      const gm = new THREE.Mesh(m.geometry, mat);
      gm.matrixWorld.copy(m.matrixWorld); // statics bake world transforms at build
      gm.matrixAutoUpdate = false;
      gm.frustumCulled = false;
      gscene.add(gm);
    }
    this._noXR(() => {
      for (const [which, target] of [[0, this.posRT], [1, this.nrmRT]]) {
        for (const gm of gscene.children) gm.material.uniforms.uWhich.value = which;
        this.renderer.setRenderTarget(target);
        this.renderer.setClearColor(0x000000, 0);
        this.renderer.clear();
        this.renderer.render(gscene, this.cam);
      }
    });
    for (const gm of gscene.children) gm.material.dispose();

    const fsGeo = new THREE.BufferGeometry();
    fsGeo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    const mkU = () => ({
      uPosG: { value: this.posRT.texture },
      uNrmG: { value: this.nrmRT.texture },
      uBase: { value: this.baseRT.texture },
      uNEnt: { value: 0 },
      uEntB: { value: Array.from({ length: MAX_ENT }, () => new THREE.Vector4()) },
      uEntM: { value: Array.from({ length: MAX_ENT }, () => new THREE.Vector4()) },
      uEntD: { value: Array.from({ length: MAX_ENT }, () => new THREE.Vector4()) },
      uCapA: { value: Array.from({ length: MAX_CAPS }, () => new THREE.Vector4()) },
      uCapB: { value: Array.from({ length: MAX_CAPS }, () => new THREE.Vector4()) },
      uAO: { value: 0.8 }, uAOClamp: { value: 0.03 }, uShadow: { value: 0.85 },
    });
    const mkMat = frag => new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: 'void main() { gl_Position = vec4(position, 1.0); }',
      fragmentShader: frag, uniforms: mkU(), depthTest: false, depthWrite: false,
    });
    this.baseMat = mkMat(BASE_FRAG);
    // static batches multiply into the white-cleared accumulator
    this.baseMat.blending = THREE.CustomBlending;
    this.baseMat.blendSrc = THREE.DstColorFactor;
    this.baseMat.blendDst = THREE.ZeroFactor;
    this.dynMat = mkMat(DYN_FRAG);
    this.dilateMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: 'void main() { gl_Position = vec4(position, 1.0); }',
      fragmentShader: DILATE_FRAG,
      uniforms: { uSrc: { value: null }, uPosG: { value: this.posRT.texture } },
      depthTest: false, depthWrite: false,
    });
    this.fsMesh = new THREE.Mesh(fsGeo, this.baseMat);
    this.fsMesh.frustumCulled = false;
    this.fsScene = new THREE.Scene();
    this.fsScene.add(this.fsMesh);
    // exact copy of last frame's dyn uniforms + dials: the splat only re-runs
    // when a prop actually moved (sleeping physics = zero layer cost)
    this._sig = new Float32Array(4 + MAX_ENT * 11 + MAX_CAPS * 7);
    this._sigValid = false;
  }

  get texture() { return this.layerRT.texture; }

  // presenting XR hijacks render() with the array camera and splits the
  // viewport per eye - never what a fullscreen splat pass wants. Also
  // restores render target and clear color (the gbuf/base passes change it).
  _noXR(fn) {
    const xr = this.renderer.xr.enabled;
    const oldRT = this.renderer.getRenderTarget();
    const oldCC = this.renderer.getClearColor(new THREE.Color());
    const oldCA = this.renderer.getClearAlpha();
    this.renderer.xr.enabled = false;
    fn();
    this.renderer.setRenderTarget(oldRT);
    this.renderer.setClearColor(oldCC, oldCA);
    this.renderer.xr.enabled = xr;
  }

  _run(target, mat) {
    this.fsMesh.material = mat;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.fsScene, this.cam);
  }

  // entries in the OccluderSystem's native shape: e.world = [[Vector4(a,r),
  // Vector4(b,-)], ...] plus e.group and (dyn only) e.shadowDir (Vector4:
  // dir xyz, span). Packs from entries[start]; returns the next unpacked index.
  _fillEntries(mat, entries, start) {
    const u = mat.uniforms;
    let cap = 0, ne = 0, i = start;
    for (; i < entries.length; i++) {
      const e = entries[i];
      if (ne >= MAX_ENT || cap + e.world.length > MAX_CAPS) break;
      // entry bounding sphere over both capsule endpoints (pack-time math)
      let cx = 0, cy = 0, cz = 0;
      for (const [wa, wb] of e.world) {
        cx += (wa.x + wb.x) / 2; cy += (wa.y + wb.y) / 2; cz += (wa.z + wb.z) / 2;
      }
      const n = e.world.length;
      cx /= n; cy /= n; cz /= n;
      let rb = 0;
      for (const [wa, wb] of e.world) {
        rb = Math.max(rb,
          Math.hypot(wa.x - cx, wa.y - cy, wa.z - cz) + wa.w,
          Math.hypot(wb.x - cx, wb.y - cy, wb.z - cz) + wa.w);
      }
      u.uEntB.value[ne].set(cx, cy, cz, rb);
      u.uEntM.value[ne].set(cap, n, e.group || 0, 0);
      if (u.uEntD) {
        if (e.shadowDir) u.uEntD.value[ne].copy(e.shadowDir);
        else u.uEntD.value[ne].set(0, 1, 0, 0);
      }
      for (const [wa, wb] of e.world) {
        u.uCapA.value[cap].copy(wa);
        u.uCapB.value[cap].set(wb.x, wb.y, wb.z, 0);
        cap++;
      }
      ne++;
    }
    u.uNEnt.value = ne;
    return i;
  }

  _setDials(mat, dials) {
    mat.uniforms.uAO.value = dials.ao;
    mat.uniforms.uAOClamp.value = dials.aoClamp;
    if (mat.uniforms.uShadow) mat.uniforms.uShadow.value = dials.shadow;
    if (mat.uniforms.uPenSoft) mat.uniforms.uPenSoft.value = dials.penSoft || 0;
  }

  // once at load, after all addStatic/addPiece registration: static proxies
  // with the group skip, in batches, then dilate into the gutters
  bakeBase(staticEntries, dials) {
    this._setDials(this.baseMat, dials);
    this._noXR(() => {
      this.renderer.setRenderTarget(this.spareRT);
      this.renderer.setClearColor(0xffffff, 1);
      this.renderer.clear();
      let i = 0;
      while (i < staticEntries.length) {
        const next = this._fillEntries(this.baseMat, staticEntries, i);
        if (next === i) { console.error('dynocc: static entry too large, skipped'); i++; continue; }
        i = next;
        this._run(this.spareRT, this.baseMat);
      }
      this.dilateMat.uniforms.uSrc.value = this.spareRT.texture;
      this._run(this.baseRT, this.dilateMat);
    });
    this._sigValid = false; // dyn layer must rebuild over the new baseline
    // seed the LAYER with the fresh baseline immediately: during ?bake=1 the
    // frame loop (state.baking) never runs update() before the cubemap
    // captures, and an unrendered layerRT reads all-zero - every static
    // would multiply its diffuse by 0 and the captures come out black
    this.update([], { ao: 0.8, aoClamp: 0.03, shadow: 0.85, penSoft: 0 });
  }

  // per frame with the DYNAMIC entries only (props): splat over the baseline,
  // dilate into the gutters. Entries past the uniform capacity are dropped
  // (16 entries / 64 capsules >> the prop count on every platform).
  update(dynEntries, dials) {
    this._setDials(this.dynMat, dials);
    const end = this._fillEntries(this.dynMat, dynEntries, 0);
    if (end < dynEntries.length) {
      console.warn(`dynocc: ${dynEntries.length - end} dyn entries past capacity, dropped`);
    }
    // change detection: exact compare of everything the splat reads, so a
    // fully at-rest scene costs zero GPU (physics sleep = layer sleep)
    const u = this.dynMat.uniforms, sig = this._sig;
    const ne = u.uNEnt.value;
    let p = 0, same = this._sigValid;
    const test = v => {
      if (sig[p] !== v) { sig[p] = v; same = false; }
      p++;
    };
    test(ne); test(dials.ao); test(dials.aoClamp); test(dials.shadow);
    test(dials.penSoft || 0);
    let caps = 0;
    for (let e = 0; e < ne; e++) {
      const B = u.uEntB.value[e], M = u.uEntM.value[e], D = u.uEntD.value[e];
      test(B.x); test(B.y); test(B.z); test(B.w);
      test(M.x); test(M.y); test(M.z);
      test(D.x); test(D.y); test(D.z); test(D.w);
      caps = Math.max(caps, M.x + M.y);
    }
    for (let c = 0; c < caps; c++) {
      const A = u.uCapA.value[c], Bc = u.uCapB.value[c];
      test(A.x); test(A.y); test(A.z); test(A.w);
      test(Bc.x); test(Bc.y); test(Bc.z);
    }
    if (same) return;
    this._sigValid = true;
    this._noXR(() => {
      this._run(this.spareRT, this.dynMat);
      this.dilateMat.uniforms.uSrc.value = this.spareRT.texture;
      this._run(this.layerRT, this.dilateMat);
    });
  }
}
