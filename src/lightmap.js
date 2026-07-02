// GPU path-traced lightmapper — the ground-truth lighting source.
//
// All static geometry (already in world space, with packed uv2 charts) is
// merged into one mesh with per-vertex albedo/emissive, raytraced in-shader
// via three-mesh-bvh. The lightmap stores "diffuse light" D (irradiance-ish),
// rendered as albedo × D — same convention as the analytic path it replaces.
//
// Passes:
//   1. G-buffer: rasterize charts in uv2 space -> world position + normal
//   2. K shading iterations (ping-pong): direct = shadow-rayed point lights +
//      panel AREA lights (2 samples each); indirect = RAYS cosine rays
//      gathering albedo×D from the previous iteration -> converged bounces
//   3. Dilation: flood chart borders so bilinear filtering never reads void
import * as THREE from 'three';
import { MeshBVH, MeshBVHUniformStruct, shaderStructs, shaderIntersectFunction } from '../libs/three-mesh-bvh.module.js';

const FS_VERT = /* glsl */`
in vec2 position;
void main() { gl_Position = vec4(position, 0.0, 1.0); }
`;

const GBUF_VERT = /* glsl */`
in vec3 position;
in vec3 normal;
in vec2 lmuv;
out vec3 vPos;
out vec3 vNrm;
void main() {
  vPos = position;
  vNrm = normal;
  gl_Position = vec4(lmuv * 2.0 - 1.0, 0.0, 1.0);
}
`;

const GBUF_FRAG = /* glsl */`
precision highp float;
in vec3 vPos;
in vec3 vNrm;
uniform float uWhich; // 0 = position, 1 = normal
out vec4 fragColor;
void main() {
  fragColor = uWhich < 0.5 ? vec4(vPos, 1.0) : vec4(normalize(vNrm), 1.0);
}
`;

function ptFrag(rays, panelSamples) {
  return /* glsl */`
precision highp float;
precision highp isampler2D;
precision highp usampler2D;
${shaderStructs}
${shaderIntersectFunction}
uniform BVH bvh;
uniform sampler2D uPos;
uniform sampler2D uNrm;
uniform sampler2D uPrev;
uniform sampler2D uFace;   // 3 texels/face: uv2 triplet, albedo, emissive
uniform vec3 uLightPos[16];
uniform vec3 uLightCol[16];
uniform int uNLights;
uniform vec4 uPanelA[12];  // center.xyz, half sx
uniform vec4 uPanelB[12];  // half sz, emissive rgb
uniform int uNPanels;
uniform float uSeed;
uniform float uGather;
out vec4 fragColor;

vec4 faceFetch(uint f, int k) {
  int i = int(f) * 3 + k;
  return texelFetch(uFace, ivec2(i % 2048, i / 2048), 0);
}

// pcg-ish hash -> [0,1)
float rnd(inout uint state) {
  state = state * 747796405u + 2891336453u;
  uint w = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return float((w >> 22u) ^ w) / 4294967296.0;
}

bool occluded(vec3 from, vec3 to) {
  vec3 d = to - from;
  float len = length(d);
  d /= len;
  uvec4 fi; vec3 fn, bc; float side, dist;
  if (bvhIntersectFirstHit(bvh, from, d, fi, fn, bc, side, dist)) return dist < len - 0.03;
  return false;
}

void main() {
  ivec2 tx = ivec2(gl_FragCoord.xy);
  vec4 pw = texelFetch(uPos, tx, 0);
  if (pw.a < 0.5) { fragColor = vec4(0.0); return; }
  vec3 P = pw.xyz;
  vec3 N = texelFetch(uNrm, tx, 0).xyz;
  vec3 Po = P + N * 0.02;
  uint seed = uint(tx.x) * 1973u ^ uint(tx.y) * 9277u ^ uint(uSeed * 26699.0);

  vec3 direct = vec3(0.0);
  for (int i = 0; i < 16; i++) {
    if (i >= uNLights) break;
    vec3 L = uLightPos[i] - Po;
    float d2 = dot(L, L);
    float ndl = dot(N, normalize(L));
    if (ndl <= 0.0) continue;
    if (occluded(Po, uLightPos[i])) continue;
    direct += uLightCol[i] * (ndl / max(d2, 0.05)); // true inverse-square
  }
  for (int i = 0; i < 12; i++) {
    if (i >= uNPanels) break;
    vec3 c = uPanelA[i].xyz;
    float hx = uPanelA[i].w, hz = uPanelB[i].x;
    vec3 Le = uPanelB[i].yzw;
    float area = 4.0 * hx * hz;
    vec3 acc = vec3(0.0);
    for (int s = 0; s < ${panelSamples}; s++) {
      vec3 rp = c + vec3((rnd(seed) - 0.5) * 2.0 * hx, 0.0, (rnd(seed) - 0.5) * 2.0 * hz);
      vec3 L = rp - Po;
      float d2 = dot(L, L);
      vec3 Ln = L * inversesqrt(d2);
      float cosS = dot(N, Ln);
      float cosL = abs(Ln.y); // horizontal emitters
      if (cosS <= 0.0) continue;
      if (occluded(Po, rp)) continue;
      acc += Le * (cosS * cosL * area / (3.14159 * max(d2, 0.25)));
    }
    direct += acc / float(${panelSamples});
  }

  vec3 bounce = vec3(0.0);
  if (uGather > 0.5) {
    vec3 up = abs(N.y) < 0.98 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    vec3 T = normalize(cross(up, N));
    vec3 B = cross(N, T);
    for (int s = 0; s < ${rays}; s++) {
      float x1 = rnd(seed), x2 = rnd(seed);
      float phi = 6.2831853 * x2;
      float st = sqrt(x1), ct = sqrt(1.0 - x1);
      vec3 dir = T * (st * cos(phi)) + B * (st * sin(phi)) + N * ct;
      uvec4 fi; vec3 fn, bc; float side, dist;
      if (!bvhIntersectFirstHit(bvh, Po, dir, fi, fn, bc, side, dist)) continue;
      vec4 r0 = faceFetch(fi.w, 0);
      vec4 r1 = faceFetch(fi.w, 1);
      vec2 uv2h = bc.x * r0.xy + bc.y * r0.zw + bc.z * r1.xy;
      vec3 alb = vec3(r1.zw, faceFetch(fi.w, 2).x);
      // emitters aren't in the BVH at all (no shadows, no self-occlusion of
      // their own NEE samples) — their light enters solely via the area NEE
      bounce += alb * texture(uPrev, uv2h).rgb;
    }
    bounce /= float(${rays});
  }

  fragColor = vec4(direct + bounce, 1.0);
}
`;
}

// flood-fill uncovered texels from covered neighbors (chart gutters)
const DILATE_FRAG = /* glsl */`
precision highp float;
uniform sampler2D uSrc;
out vec4 fragColor;
void main() {
  ivec2 tx = ivec2(gl_FragCoord.xy);
  vec4 c = texelFetch(uSrc, tx, 0);
  if (c.a > 0.5) { fragColor = c; return; }
  vec4 sum = vec4(0.0);
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      vec4 s = texelFetch(uSrc, tx + ivec2(dx, dy), 0);
      if (s.a > 0.5) sum += vec4(s.rgb, 1.0);
    }
  }
  fragColor = sum.a > 0.0 ? vec4(sum.rgb / sum.a, 1.0) : vec4(0.0);
}
`;

export class Lightmapper {
  constructor(renderer, level, textures, opts = {}) {
    this.renderer = renderer;
    this.level = level;
    this.rays = opts.rays || 64;
    this.iterations = opts.iterations || 3;
    this.panelSamples = opts.panelSamples || 2;
    const [W, H] = level.lightmapSize;
    this.size = [W, H];

    // ---- merge all builders (world space) with per-vertex albedo/emissive.
    // Emissive fixtures are EXCLUDED: emitters must not cast shadows (or
    // self-occlude their own area-light samples); they illuminate via NEE and
    // render emissive-only (their unwritten lightmap texels stay black).
    const pos = [], nrm = [], uv2 = [], alb = [], emi = [];
    for (const cell of level.cells) {
      for (const [, b] of cell.builders) {
        const g = b.geo;
        if (g.empty) continue;
        const o = b.opts || {};
        if (o.emissive && (o.emissive[0] > 0 || o.emissive[1] > 0 || o.emissive[2] > 0)) continue;
        let a = [0.5, 0.5, 0.5];
        if (o.paintingIndex !== undefined) a = [0.35, 0.3, 0.28];
        else if (o.mapKey && textures[o.mapKey]) a = textures[o.mapKey].map.userData.avg;
        const tint = o.tint || [1, 1, 1];
        a = [a[0] * tint[0], a[1] * tint[1], a[2] * tint[2]];
        const e = o.emissive || [0, 0, 0];
        const nv = g.pos.length / 3;
        for (let i = 0; i < nv; i++) {
          pos.push(g.pos[i * 3], g.pos[i * 3 + 1], g.pos[i * 3 + 2]);
          nrm.push(g.nrm[i * 3], g.nrm[i * 3 + 1], g.nrm[i * 3 + 2]);
          uv2.push(g.uv2[i * 2], g.uv2[i * 2 + 1]);
          alb.push(a[0], a[1], a[2]);
          emi.push(e[0], e[1], e[2]);
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    geo.setAttribute('lmuv', new THREE.Float32BufferAttribute(uv2, 2));
    this.triCount = pos.length / 9;

    // BVH (this reorders/creates the index; face records must be built AFTER)
    this.bvh = new MeshBVH(geo);
    this.bvhUniform = new MeshBVHUniformStruct();
    this.bvhUniform.updateFrom(this.bvh);

    // per-face records: uv2 triplet + albedo + emissive, 3 texels per face
    const index = geo.index ? geo.index.array : null;
    const nFace = (index ? index.length : pos.length / 3) / 3;
    const recW = 2048, recH = Math.max(1, Math.ceil((nFace * 3) / recW));
    const rec = new Float32Array(recW * recH * 4);
    for (let f = 0; f < nFace; f++) {
      const vi = [0, 1, 2].map(k => (index ? index[f * 3 + k] : f * 3 + k));
      const base = f * 3 * 4;
      rec[base + 0] = uv2[vi[0] * 2]; rec[base + 1] = uv2[vi[0] * 2 + 1];
      rec[base + 2] = uv2[vi[1] * 2]; rec[base + 3] = uv2[vi[1] * 2 + 1];
      rec[base + 4] = uv2[vi[2] * 2]; rec[base + 5] = uv2[vi[2] * 2 + 1];
      rec[base + 6] = alb[vi[0] * 3]; rec[base + 7] = alb[vi[0] * 3 + 1];
      rec[base + 8] = alb[vi[0] * 3 + 2];
      rec[base + 9] = emi[vi[0] * 3]; rec[base + 10] = emi[vi[0] * 3 + 1];
      rec[base + 11] = emi[vi[0] * 3 + 2];
    }
    this.faceTex = new THREE.DataTexture(rec, recW, recH, THREE.RGBAFormat, THREE.FloatType);
    this.faceTex.needsUpdate = true;

    // ---- render targets
    const rt = (type, filter) => new THREE.WebGLRenderTarget(W, H, {
      type, minFilter: filter, magFilter: filter,
      generateMipmaps: false, depthBuffer: false,
    });
    this.posRT = rt(THREE.FloatType, THREE.NearestFilter);   // texelFetch only
    this.nrmRT = rt(THREE.FloatType, THREE.NearestFilter);
    this.lmA = rt(THREE.HalfFloatType, THREE.LinearFilter);
    this.lmB = rt(THREE.HalfFloatType, THREE.LinearFilter);

    // ---- pass materials
    this.gbufMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: GBUF_VERT, fragmentShader: GBUF_FRAG,
      uniforms: { uWhich: { value: 0 } }, side: THREE.DoubleSide, depthTest: false, depthWrite: false,
    });
    this.bakeMesh = new THREE.Mesh(geo, this.gbufMat);
    this.bakeMesh.frustumCulled = false;
    this.bakeScene = new THREE.Scene();
    this.bakeScene.add(this.bakeMesh);
    this.cam = new THREE.Camera();

    // lights: unique analytic points + panel area lights
    const lp = [], lc = [];
    const seen = new Set();
    for (const cell of level.cells) {
      for (const l of cell.lights) {
        const key = l.pos.join(',');
        if (seen.has(key)) continue;
        seen.add(key);
        lp.push(new THREE.Vector3(...l.pos));
        lc.push(new THREE.Vector3(l.color[0] * l.intensity, l.color[1] * l.intensity, l.color[2] * l.intensity));
      }
    }
    while (lp.length < 16) { lp.push(new THREE.Vector3()); lc.push(new THREE.Vector3()); }
    const pa = [], pb = [];
    for (const pn of level.panels) {
      const c = pn.color, e = pn.intensity;
      pa.push(new THREE.Vector4(pn.x, pn.y, pn.z, pn.sx / 2));
      pb.push(new THREE.Vector4(pn.sz / 2, e * c[0], e * c[1], e * c[2]));
    }
    this.nPanels = pa.length;
    while (pa.length < 12) { pa.push(new THREE.Vector4()); pb.push(new THREE.Vector4()); }

    this.ptUniforms = {
      bvh: { value: this.bvhUniform },
      uPos: { value: this.posRT.texture },
      uNrm: { value: this.nrmRT.texture },
      uPrev: { value: this.lmB.texture },
      uFace: { value: this.faceTex },
      uLightPos: { value: lp },
      uLightCol: { value: lc },
      uNLights: { value: seen.size },
      uPanelA: { value: pa },
      uPanelB: { value: pb },
      uNPanels: { value: this.nPanels },
      uSeed: { value: 0.37 },
      uGather: { value: 0 },
    };
    const fsGeo = new THREE.BufferGeometry();
    fsGeo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 3, -1, -1, 3], 2));
    fsGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 10);
    this.fsMesh = new THREE.Mesh(fsGeo, null);
    this.fsMesh.frustumCulled = false;
    this.fsScene = new THREE.Scene();
    this.fsScene.add(this.fsMesh);

    this.ptMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: FS_VERT, fragmentShader: ptFrag(this.rays, this.panelSamples),
      uniforms: this.ptUniforms, depthTest: false, depthWrite: false,
    });
    this.dilateMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: FS_VERT, fragmentShader: DILATE_FRAG,
      uniforms: { uSrc: { value: this.lmA.texture } }, depthTest: false, depthWrite: false,
    });
  }

  get texture() { return this.lmA.texture; }

  // scissored strip draw: path tracing the whole map in one draw risks GPU
  // watchdog kills (TDR / context loss) — split into small strips instead
  runFs(target, material, sy = 0, sh = 0) {
    target.viewport.set(0, 0, this.size[0], this.size[1]);
    if (sh > 0) {
      target.scissor.set(0, sy, this.size[0], sh);
      target.scissorTest = true;
    } else {
      target.scissorTest = false;
    }
    this.fsMesh.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.fsScene, this.cam);
  }

  get strips() { return Math.ceil(this.size[1] / 64); }

  totalSteps() { return 2 + this.iterations * this.strips + 2; }

  *bakeSteps() {
    const { renderer } = this;
    // G-buffer
    this.gbufMat.uniforms.uWhich.value = 0;
    renderer.setRenderTarget(this.posRT);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(this.bakeScene, this.cam);
    yield;
    this.gbufMat.uniforms.uWhich.value = 1;
    renderer.setRenderTarget(this.nrmRT);
    renderer.clear();
    renderer.render(this.bakeScene, this.cam);
    yield;
    // shading iterations: read lmB (previous), write lmA, swap
    renderer.setRenderTarget(this.lmB);
    renderer.clear();
    for (let it = 0; it < this.iterations; it++) {
      this.ptUniforms.uPrev.value = this.lmB.texture;
      this.ptUniforms.uGather.value = it === 0 ? 0 : 1;
      this.ptUniforms.uSeed.value = 0.173 + it * 0.619;
      for (let s = 0; s < this.strips; s++) {
        this.runFs(this.lmA, this.ptMat, s * 64, 64);
        yield;
      }
      const t = this.lmA; this.lmA = this.lmB; this.lmB = t; // newest -> lmB
    }
    // after the loop the newest data sits in lmB; one more swap puts it in lmA
    const t = this.lmA; this.lmA = this.lmB; this.lmB = t;
    // dilation ping-pong (2 passes)
    for (let d = 0; d < 2; d++) {
      this.dilateMat.uniforms.uSrc.value = this.lmA.texture;
      this.runFs(this.lmB, this.dilateMat);
      const s = this.lmA; this.lmA = this.lmB; this.lmB = s;
      yield;
    }
    renderer.setRenderTarget(null);
  }
}
