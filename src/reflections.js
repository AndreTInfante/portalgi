// Planar CONTACT reflections for props and furniture: the baked atlas can't
// show dynamic objects (and smears static contact detail), so mirror an
// analytic blob under each object on reflective floors.
//
// The blob is a rounded tapered cone: a 2D contact ellipse pinned exactly at
// the mirror plane (fitted to the mesh's ground footprint), a second 2D
// ellipse at the object's widest band - with its own center, so overhangs
// stay aligned - a distance between the two planes, and rounded caps. The
// fragment shader minimizes the implicit function along the view ray, so the
// silhouette is exact and soft regardless of mesh tessellation (the sphere
// mesh is only a raster footprint). A short gaussian falloff on depth below
// the plane kills the deep/widest part entirely: it reads as a contact
// reflection, strongest where object meets floor.
//
// All look parameters live in this.params (see DEFAULTS) and are driven live
// by the GUI 'Smudges' folder; fit* / manual* changes need refit(), which the
// GUI calls automatically.
import * as THREE from 'three';
import { findCell } from './level.js';

const REFLECTIVE_MAX_ROUGHFACTOR = 0.75; // floors glossier than this get smudges

// user-tuned 2026-07 (in-app Smudges dashboard, dumped values, round 2)
const DEFAULTS = {
  opacity: 0.86,      // base alpha (x brightComp: 0.90 eff on wood, 0.65 on marble)
  feather: 1.26,      // silhouette softness: smoothstep width on the implicit
  fadeBase: 0.02,     // gaussian depth scale, FRACTION of blob depth, on a
  fadeRough: 0.46,    // rough floor... plus this much extra on a glossy one:
                      // depth reach is almost entirely gloss-driven
  fresnelMin: 0.16,   // reflectance floor at normal incidence (rough spec)
  breakBase: 0.75,    // alpha = clamp(breakBase - floorRoughness*breakSlope)
  breakSlope: 1.05,
  widenBase: 0.05,    // deep-ellipse widening, fraction of cone height...
  widenRough: 0.5,    // ...plus this much scaled by floor roughness
  liftFade: 0.3,      // e-folding height (m) for objects lifted off the floor
  tintGain: 0.14,     // multiplier on smudge colors: near-black dark shapes
                      // read best (colored reflections need albedo averages)
  brightComp: 0.175,  // equalize perceived darkening across floor albedos:
                      // 0 = constant alpha, 1 = full 1/luminance compensation.
                      // Solved from Andre's calibration (0.90 wood / 0.65 marble)
  // fit-time (refit() to apply)
  fitContactBand: 0.6,  // bottom fraction of object height = contact footprint
  fitWidestLo: 0.15,    // height band sampled for the widest ellipse
  fitWidestHi: 0.7,
  fitHFrac: 0.67,       // widest-plane height as fraction of object height
  fitAxisScale: 0.67,   // half-axis = band extent * this (0.5 = exact)
  // authored contacts (benches/pedestals/pillar; refit() to apply)
  manualScale: 1.53,    // contact half-axes = collider footprint * this
  manualTaper: 1.0,     // widest = contact * this
  manualH: 1.3,         // plane distance (m)
};

const VERT = /* glsl */`
varying vec3 vWorld;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FRAG = /* glsl */`
precision highp float;
uniform vec3 uColor;
uniform float uOpacity;
uniform float uFeather;
uniform float uFresnelMin;
uniform float uBreakBase;
uniform float uBreakSlope;
uniform float uFade;    // gaussian depth scale: contact zone only
uniform float uLift;    // whole-smudge fade when the object leaves the floor
uniform float uBright;  // floor-albedo compensation (dimmer on bright floors)
uniform sampler2D uFloorOrm;
uniform float uFloorRoughF;
uniform vec4 uBounds;   // cell floor bbox: minX, minZ, maxX, maxZ
uniform mat4 uInvW;     // world -> cone frame (origin at contact center, y up into the blob)
uniform vec2 uA0;       // contact ellipse half-axes (at y=0)
uniform vec2 uA1;       // widest ellipse half-axes (at y=uH, pre-widened by floor roughness)
uniform vec2 uC1;       // xz offset of the widest ellipse center
uniform float uH;       // distance between the two ellipse planes
uniform vec2 uRound;    // cap rounding below/above the two planes
uniform vec3 uBC;       // bounding ellipsoid center (cone frame)
uniform vec3 uBR;       // bounding ellipsoid radii
uniform float uExposure;
varying vec3 vWorld;
vec3 acesTonemap(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}
// tapered-cone implicit: cross sections are ellipses lerped (axes AND center)
// between the contact plane (y=0) and the widest plane (y=uH), rounded caps
float coneF(vec3 p) {
  float yc = clamp(p.y, 0.0, uH);
  float f = yc / max(uH, 1e-3);
  vec2 q = (p.xz - uC1 * f) / mix(uA0, uA1, f);
  float e = (p.y - yc) / (p.y < 0.0 ? uRound.x : uRound.y);
  return dot(q, q) + e * e - 1.0;
}
void main() {
  if (vWorld.x < uBounds.x || vWorld.z < uBounds.y ||
      vWorld.x > uBounds.z || vWorld.z > uBounds.w) discard; // this cell's floor only
  // shared-parameter ray: p_frame(t) = uInvW * (cam + t*dw), dw unnormalized,
  // so the same t addresses world space (for depth) and cone space (for F)
  vec3 dw = vWorld - cameraPosition;
  vec3 o = (uInvW * vec4(cameraPosition, 1.0)).xyz;
  vec3 d = (uInvW * vec4(dw, 0.0)).xyz;
  vec3 os = (o - uBC) / uBR;
  vec3 ds = d / uBR;
  float A = dot(ds, ds), B = dot(os, ds), C = dot(os, os) - 1.0;
  float hh = B * B - A * C;
  if (hh <= 0.0) discard;
  float sq = sqrt(hh);
  float t0 = (-B - sq) / A, t1 = (-B + sq) / A;
  float Fmin = 1e9;
  float tIn = -1.0;
  float tPrev = t0;
  for (int i = 0; i < 16; i++) {
    float t = mix(t0, t1, (float(i) + 0.5) / 16.0);
    float F = coneF(o + d * t);
    Fmin = min(Fmin, F);
    if (tIn < 0.0 && F < 0.0) {
      // bisect the entry point: a smooth depth kills sample banding
      float lo = tPrev, hi = t;
      for (int j = 0; j < 4; j++) {
        float tm = 0.5 * (lo + hi);
        if (coneF(o + d * tm) < 0.0) hi = tm; else lo = tm;
      }
      tIn = 0.5 * (lo + hi);
    }
    tPrev = t;
  }
  if (Fmin >= 0.0) discard;
  float shape = smoothstep(0.0, uFeather, -Fmin); // exact soft silhouette
  // depth where the ray first meets the blob = the visible reflection
  // surface: full strength at the contact line, gaussian death with depth
  float yw = cameraPosition.y + tIn * dw.y;
  float g = max(-yw, 0.0) / uFade;
  vec3 Vf = normalize(cameraPosition - vec3(vWorld.x, 0.0, vWorld.z));
  // flattened fresnel: the floor's ROUGH spec (see the baked atlas
  // reflections) keeps substantial reflectance even near-normal
  float F5 = uFresnelMin + (1.0 - uFresnelMin) * pow(1.0 - max(Vf.y, 0.0), 5.0);
  float rgh = texture(uFloorOrm, vWorld.xz * 0.35).g * uFloorRoughF;
  float a = uOpacity
          * uBright
          * shape
          * exp(-g * g)                        // contact falloff: the deep part fades out entirely
          * uLift
          * clamp(uBreakBase - rgh * uBreakSlope, 0.0, 1.0)
          * F5;
  vec3 c = pow(acesTonemap(uColor * uExposure), vec3(1.0 / 2.2)); // scene output space
  gl_FragColor = vec4(c, clamp(a, 0.0, 1.0));
}
`;

// Fit the rounded cone to a mesh: contact ellipse from the bottom height
// band, widest ellipse from a mid band (each with 8th-92nd percentile extents
// so sparse geometry and outliers like fins don't inflate them) - everything
// above the widest plane fades out anyway.
function fitContactCone(root, P) {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const v = new THREE.Vector3();
  const pts = [];
  let minY = 1e9, maxY = -1e9;
  root.traverse(o => {
    if (!o.isMesh) return;
    const pos = o.geometry.getAttribute('position');
    const m = new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld);
    const step = Math.max(1, Math.floor(pos.count / 600));
    for (let i = 0; i < pos.count; i += step) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m);
      pts.push([v.x, v.y, v.z]);
      if (v.y < minY) minY = v.y;
      if (v.y > maxY) maxY = v.y;
    }
  });
  if (!pts.length) return null;
  const H = Math.max(maxY - minY, 0.02);
  const ellipse = (band) => {
    if (band.length < 4) return null;
    const pick = (arr, q) => arr[Math.min(arr.length - 1, Math.floor(q * arr.length))];
    const xs = band.map(p => p[0]).sort((a, b) => a - b);
    const zs = band.map(p => p[2]).sort((a, b) => a - b);
    const x0 = pick(xs, 0.08), x1 = pick(xs, 0.92);
    const z0 = pick(zs, 0.08), z1 = pick(zs, 0.92);
    return {
      c: new THREE.Vector2((x0 + x1) / 2, (z0 + z1) / 2),
      a: new THREE.Vector2(Math.max((x1 - x0) * P.fitAxisScale, 0.04),
                           Math.max((z1 - z0) * P.fitAxisScale, 0.04)),
    };
  };
  const contact = ellipse(pts.filter(p => p[1] <= minY + Math.max(P.fitContactBand * H, 0.05)));
  const widest = ellipse(pts.filter(p => p[1] >= minY + P.fitWidestLo * H && p[1] <= minY + P.fitWidestHi * H))
    || contact;
  if (!contact) return null;
  const h = Math.max(P.fitHFrac * H, 0.05);
  return {
    c0: new THREE.Vector3(contact.c.x, minY, contact.c.y),
    a0: contact.a,
    a1: new THREE.Vector2(Math.max(widest.a.x, contact.a.x), Math.max(widest.a.y, contact.a.y)),
    c1: new THREE.Vector2(widest.c.x - contact.c.x, widest.c.y - contact.c.y),
    h,
    round: new THREE.Vector2(0.02, Math.max(0.25 * h, 0.05)),
  };
}

const S_MIRROR = new THREE.Matrix4().makeScale(1, -1, 1);
const IDENT_Q = new THREE.Quaternion();

export class ReflectionSystem {
  constructor(scene, level, props, globals) {
    this.level = level;
    this.props = props;
    this.globals = globals;
    this.enabled = true;
    this.staticImposters = false; // A/B: horse/whale via imposter vs baked capture
    this.params = { ...DEFAULTS };
    // shared BY IDENTITY across all smudge materials (like matsys.globals)
    this.shared = {
      uOpacity: { value: this.params.opacity },
      uFeather: { value: this.params.feather },
      uFresnelMin: { value: this.params.fresnelMin },
      uBreakBase: { value: this.params.breakBase },
      uBreakSlope: { value: this.params.breakSlope },
    };
    this.group = new THREE.Group();
    scene.add(this.group);
    this.footprint = new THREE.SphereGeometry(1.04, 24, 16);

    this.cellInfo = level.cells.map(c => {
      const reflective = c.floor.roughFactor <= REFLECTIVE_MAX_ROUGHFACTOR;
      const xs = c.fp.map(p => p[0]), zs = c.fp.map(p => p[1]);
      return reflective ? {
        bounds: new THREE.Vector4(Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)),
        roughF: c.floor.roughFactor,
      } : null;
    });

    this.entries = [];
    for (const p of props.list) {
      if (p.debugPane) continue; // a clear glass sheet casts no solid smudge
      const t = p.mats[0] && p.mats[0].uniforms.uTint ? p.mats[0].uniforms.uTint.value : null;
      const hasMaps = p.mats[0] && p.mats[0].uniforms.uMap &&
        p.mats[0].uniforms.uMap.value && p.mats[0].uniforms.uMap.value.image &&
        p.mats[0].uniforms.uMap.value.image.width > 8;
      // textured props carry tint [1,1,1]; their real albedo is in maps we
      // never averaged - default DARK so alpha-over darkens the floor
      const col = hasMaps ? [0.16, 0.15, 0.14]
        : t ? [t.x * 0.4, t.y * 0.4, t.z * 0.4] : [0.2, 0.2, 0.2];
      this._makeEntry(p, col, fitContactCone(p.mesh, this.params), false);
    }
  }

  // lightmapped static exhibits (world-space geometry; gated by staticImposters)
  addStatic(mesh) {
    this._makeEntry({ mesh, cell: mesh.userData.cell }, [0.13, 0.12, 0.11],
      fitContactCone(mesh, this.params), true);
  }

  _manualFit(spec) {
    const P = this.params;
    const rx = (spec.rx !== undefined ? spec.rx : spec.r) * P.manualScale;
    const rz = (spec.rz !== undefined ? spec.rz : spec.r) * P.manualScale;
    return {
      a0: new THREE.Vector2(rx, rz),
      a1: new THREE.Vector2(rx * P.manualTaper, rz * P.manualTaper),
      c1: new THREE.Vector2(0, 0),
      h: P.manualH,
      round: new THREE.Vector2(0.02, Math.max(0.25 * P.manualH, 0.05)),
    };
  }

  // authored contact smudge (benches, pedestals, the pillar) - always on.
  // spec: {r} round, or {rx, rz, rot} for a rotated elliptical footprint.
  addContact(x, z, spec, cellIds) {
    if (typeof spec === 'number') spec = { r: spec };
    const cells = cellIds || [findCell(this.level.cells, new THREE.Vector3(x, 0.5, z))];
    for (const cid of cells) {
      const e = this._makeEntry({ mesh: null, cell: cid }, [0.14, 0.13, 0.12],
        { c0: new THREE.Vector3(x, 0, z), ...this._manualFit(spec) }, false);
      if (e) { e.manual = true; e.manualSpec = spec; e.rot = spec.rot || 0; }
    }
  }

  // re-run the mesh fits / rebuild authored cones after a fit* or manual*
  // parameter change (GUI calls this)
  refit() {
    for (const e of this.entries) {
      if (e.manual) {
        Object.assign(e.fit, this._manualFit(e.manualSpec));
      } else {
        const f = fitContactCone(e.prop.mesh, this.params);
        if (f) e.fit = f;
      }
      e.mat.uniforms.uA0.value.copy(e.fit.a0);
      e.mat.uniforms.uC1.value.copy(e.fit.c1);
      e.mat.uniforms.uH.value = e.fit.h;
      e.mat.uniforms.uRound.value.copy(e.fit.round);
    }
  }

  dumpParams() {
    const json = JSON.stringify(this.params, null, 2);
    console.log('smudge params:', json);
    if (navigator.clipboard) navigator.clipboard.writeText(json).catch(() => {});
    return json;
  }

  _makeEntry(p, col, fit, isStatic) {
    if (!fit) return null;
    const mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: 'layout(location=0) out vec4 fragOut;\n#define gl_FragColor fragOut\n' + FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      stencilWrite: true,       // enables the stencil unit...
      stencilWriteMask: 0,      // ...but never writes
      stencilFunc: THREE.EqualStencilFunc,
      stencilRef: 1,
      uniforms: {
        ...this.shared, // shared identity - do not clone
        uColor: { value: new THREE.Vector3(...col) },
        uFade: { value: 0.4 },
        uLift: { value: 1 },
        uBright: { value: 1 },
        uFloorOrm: { value: null },
        uFloorRoughF: { value: 1 },
        uBounds: { value: new THREE.Vector4() },
        uInvW: { value: new THREE.Matrix4() },
        uA0: { value: fit.a0.clone() },
        uA1: { value: fit.a1.clone() },
        uC1: { value: fit.c1.clone() },
        uH: { value: fit.h },
        uRound: { value: fit.round.clone() },
        uBC: { value: new THREE.Vector3() },
        uBR: { value: new THREE.Vector3() },
        uExposure: this.globals.uExposure, // shared identity with the scene
      },
    });
    const mesh = new THREE.Mesh(this.footprint, mat);
    mesh.matrixAutoUpdate = false;
    mesh.frustumCulled = false;
    mesh.renderOrder = 5;
    mesh.layers.set(3); // never in bake captures
    mesh.visible = false;
    this.group.add(mesh);
    const e = {
      prop: p, mesh, mat, isStatic, manual: false, fit,
      baseCol: new THREE.Vector3(...col),
      frame: new THREE.Matrix4(), local: new THREE.Matrix4(),
      sv: new THREE.Vector3(), sv2: new THREE.Vector3(),
    };
    this.entries.push(e);
    return e;
  }

  update(floorSets, visibleCells) {
    const P = this.params;
    this.shared.uOpacity.value = P.opacity;
    this.shared.uFeather.value = P.feather;
    this.shared.uFresnelMin.value = P.fresnelMin;
    this.shared.uBreakBase.value = P.breakBase;
    this.shared.uBreakSlope.value = P.breakSlope;
    for (const e of this.entries) {
      const p = e.prop;
      const fit = e.fit;
      const info = this.enabled ? this.cellInfo[p.cell] : null;
      const propVisible = e.manual ? true : p.mesh.visible;
      let show = !!info && propVisible && (!e.isStatic || this.staticImposters)
        && (!visibleCells || visibleCells.has(p.cell));
      let lift = 1;
      if (show && !e.manual) {
        p.mesh.updateMatrixWorld(true);
        const wc = e.sv.copy(fit.c0).applyMatrix4(p.mesh.matrixWorld);
        lift = Math.exp(-Math.max(wc.y, 0) / P.liftFade); // lifted objects lose contact
        if (lift < 0.02) show = false;
      }
      e.mesh.visible = show;
      if (!show) continue;

      // cone frame: origin at the contact ellipse center, y up into the blob
      // (manual entries can be yaw-rotated for elliptical footprints);
      // S_MIRROR flips it below the floor in world space
      if (e.manual) {
        e.frame.makeRotationY(e.rot).setPosition(fit.c0);
      } else {
        e.frame.makeTranslation(fit.c0.x, fit.c0.y, fit.c0.z).premultiply(p.mesh.matrixWorld);
      }
      e.mat.uniforms.uLift.value = lift;
      e.mat.uniforms.uColor.value.copy(e.baseCol).multiplyScalar(P.tintGain);

      // reflection blur grows with depth on rough floors: widen the DEEP
      // ellipse only - the contact ellipse stays pinned to the footprint
      const widen = (P.widenBase + P.widenRough * info.roughF) * fit.h;
      const a1 = e.mat.uniforms.uA1.value.copy(fit.a1);
      a1.x += widen; a1.y += widen;

      // bounding ellipsoid of the blob, in the cone frame
      const rr = fit.round.y;
      // fade scales with the blob's own depth: a squat bowl's reflection dies
      // within centimeters, a bench's within its tuned look
      const fade = Math.max(
        (P.fadeBase + P.fadeRough * (1 - info.roughF)) * (fit.h + rr), 0.02);
      const bx = Math.max(fit.a0.x, a1.x + Math.abs(fit.c1.x)) * 1.1;
      const bz = Math.max(fit.a0.y, a1.y + Math.abs(fit.c1.y)) * 1.1;
      // alpha = exp(-(d/fade)^2) is ~0.02 by two fade lengths: cap the blob
      // depth there, or grazing views rasterize (and chord-march) acres of
      // floor whose pixels never survive blending
      const by = Math.min(fit.h + rr, fade * 2) * 0.55;
      e.mat.uniforms.uBC.value.set(fit.c1.x * 0.5, by, fit.c1.y * 0.5);
      e.mat.uniforms.uBR.value.set(bx, by * 1.15, bz);

      // raster footprint mesh: the bounding ellipsoid, in frame coords,
      // through the same frame + mirror
      e.local.compose(
        e.sv.set(fit.c1.x * 0.5, by, fit.c1.y * 0.5),
        IDENT_Q, e.sv2.set(bx, by * 1.15, bz))
        .premultiply(e.frame).premultiply(S_MIRROR);
      e.mesh.matrix.copy(e.local);
      e.frame.premultiply(S_MIRROR);
      e.mat.uniforms.uInvW.value.copy(e.frame).invert();

      const fs = floorSets[p.cell];
      // perceived-darkening compensation: alpha-over with a near-black color
      // removes far more absolute luminance from white marble than dark wood
      if (fs.lum === undefined) {
        const av = fs.avg || [0.15, 0.15, 0.15];
        fs.lum = Math.max(0.2126 * av[0] + 0.7152 * av[1] + 0.0722 * av[2], 0.02);
      }
      e.mat.uniforms.uBright.value = Math.min(Math.pow(0.12 / fs.lum, P.brightComp), 1.3);
      e.mat.uniforms.uFloorOrm.value = fs.ormMap;
      e.mat.uniforms.uFloorRoughF.value = info.roughF;
      e.mat.uniforms.uBounds.value.copy(info.bounds);
      e.mat.uniforms.uFade.value = fade;
    }
  }
}
