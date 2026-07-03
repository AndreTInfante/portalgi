// Planar reflection smudges for dynamic props: the baked atlas can never show
// moving objects, so mirror an ANALYTIC ELLIPSOID imposter of each prop
// beneath reflective floors (real geometry -> correct stereo depth in VR).
//
// Edge softness is the hard part: per-fragment proxies (normals, center
// gradients) cannot know they are at the screen silhouette of a low-poly
// shape. So the silhouette is made analytic instead: each prop is fit with an
// ellipsoid, and the fragment shader computes the view ray's CHORD LENGTH
// through it in closed form. Thickness reaches zero exactly and smoothly at
// the silhouette regardless of tessellation - the sphere mesh is only a
// raster footprint. Blur-cone widening = growing the ellipsoid radii with
// height on the CPU (no vertex displacement, nothing to crack).
//
// - Floor materials write stencil 1 where a reflective floor is the visible
//   surface (all other opaques write 0); imposters render depthTest-off,
//   stencil-tested, clipped to the cell floor bbox.
// - Alpha: chord softness x height falloff x the floor's ACTUAL roughness map
//   in floor-plane UV x floor fresnel at the grazing angle.
import * as THREE from 'three';

const REFLECTIVE_MAX_ROUGHFACTOR = 0.75; // floors glossier than this get smudges

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
uniform float uFade;
uniform sampler2D uFloorOrm;
uniform float uFloorRoughF;
uniform vec4 uBounds;   // cell floor bbox: minX, minZ, maxX, maxZ
uniform mat4 uInvM;     // world -> unit-sphere space of the ellipsoid
uniform float uCenterY; // depth of the mirrored ellipsoid center below floor
uniform float uExposure;
varying vec3 vWorld;
vec3 acesTonemap(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}
void main() {
  if (vWorld.x < uBounds.x || vWorld.z < uBounds.y ||
      vWorld.x > uBounds.z || vWorld.z > uBounds.w) discard; // this cell's floor only
  // analytic silhouette: chord of the view ray through the unit sphere
  vec3 ro = (uInvM * vec4(cameraPosition, 1.0)).xyz;
  vec3 rp = (uInvM * vec4(vWorld, 1.0)).xyz;
  vec3 rd = normalize(rp - ro);
  float b = dot(ro, rd);
  float c2 = dot(ro, ro) - 1.0;
  float h = b * b - c2;
  if (h <= 0.0) discard;                 // ray misses the ellipsoid
  float chord = 2.0 * sqrt(h);           // 0 at silhouette -> ~2 through center
  float shape = smoothstep(0.0, 1.1, chord);
  // fresnel of the FLOOR at the point the eye reads this smudge through
  vec3 Vf = normalize(cameraPosition - vec3(vWorld.x, 0.0, vWorld.z));
  float F = 0.05 + 0.95 * pow(1.0 - max(Vf.y, 0.0), 5.0);
  float rgh = texture(uFloorOrm, vWorld.xz * 0.35).g * uFloorRoughF;
  float a = uOpacity
          * shape
          * exp(-uCenterY / uFade)       // rough-reflection contrast dies with height
          * clamp(1.35 - rgh * 1.6, 0.0, 1.0)
          * F;
  vec3 c = pow(acesTonemap(uColor * uExposure), vec3(1.0 / 2.2)); // match scene output
  gl_FragColor = vec4(c, clamp(a, 0.0, 1.0));
}
`;

// local-space bbox of all mesh vertices under a root (for the ellipsoid fit)
function localBBox(root) {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  root.traverse(o => {
    if (!o.isMesh) return;
    const pos = o.geometry.getAttribute('position');
    const m = new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld);
    const step = Math.max(1, Math.floor(pos.count / 200));
    for (let i = 0; i < pos.count; i += step) {
      box.expandByPoint(v.fromBufferAttribute(pos, i).applyMatrix4(m));
    }
  });
  return box;
}

const S_MIRROR = new THREE.Matrix4().makeScale(1, -1, 1); // reflect about y=0
const IDENT_Q = new THREE.Quaternion();

export class ReflectionSystem {
  constructor(scene, level, props, globals) {
    this.level = level;
    this.props = props;
    this.globals = globals;
    this.enabled = true;
    this.staticImposters = false; // A/B: statics via imposter vs baked capture
    this.group = new THREE.Group();
    scene.add(this.group);
    this.footprint = new THREE.SphereGeometry(1.04, 24, 16); // shared raster hull

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
      const t = p.mats[0] && p.mats[0].uniforms.uTint ? p.mats[0].uniforms.uTint.value : { x: 0.5, y: 0.5, z: 0.5 };
      this._makeEntry(p, t, false);
    }
  }

  // lightmapped static exhibits (geometry already in world space)
  addStatic(mesh) {
    this._makeEntry({ mesh, cell: mesh.userData.cell }, { x: 0.45, y: 0.43, z: 0.4 }, true);
  }

  _makeEntry(p, tint, isStatic) {
    const box = localBBox(p.mesh);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const radii = box.getSize(new THREE.Vector3()).multiplyScalar(0.5 * 1.05);
    radii.x = Math.max(radii.x, 0.03); radii.y = Math.max(radii.y, 0.03); radii.z = Math.max(radii.z, 0.03);
    const mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: 'layout(location=0) out vec4 fragOut;\n#define gl_FragColor fragOut\n' + FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,   // mirrored transform flips winding
      stencilWrite: true,       // enables the stencil unit...
      stencilWriteMask: 0,      // ...but never writes
      stencilFunc: THREE.EqualStencilFunc,
      stencilRef: 1,
      uniforms: {
        uColor: { value: new THREE.Vector3(tint.x * 0.5, tint.y * 0.5, tint.z * 0.5) },
        uOpacity: { value: 0.85 },
        uFade: { value: 0.5 },
        uFloorOrm: { value: null },
        uFloorRoughF: { value: 1 },
        uBounds: { value: new THREE.Vector4() },
        uInvM: { value: new THREE.Matrix4() },
        uCenterY: { value: 0 },
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
    this.entries.push({
      prop: p, mesh, mat, isStatic, center, radii,
      local: new THREE.Matrix4(), scratch: new THREE.Vector3(),
    });
  }

  update(floorSets, visibleCells) {
    for (const e of this.entries) {
      const p = e.prop;
      const info = this.enabled ? this.cellInfo[p.cell] : null;
      const show = !!info && p.mesh.visible && (!e.isStatic || this.staticImposters)
        && (!visibleCells || visibleCells.has(p.cell));
      e.mesh.visible = show;
      if (!show) continue;
      p.mesh.updateMatrixWorld(true);
      // ellipsoid center height above the floor drives fade + cone widening
      const wc = e.scratch.copy(e.center).applyMatrix4(p.mesh.matrixWorld);
      const hgt = Math.max(wc.y, 0);
      const widen = (0.15 + 0.5 * info.roughF) * hgt;
      e.scratch.set(e.radii.x + widen, e.radii.y + widen * 0.4, e.radii.z + widen);
      e.local.compose(e.center, IDENT_Q, e.scratch);
      e.mesh.matrix.copy(p.mesh.matrixWorld).multiply(e.local).premultiply(S_MIRROR);
      e.mat.uniforms.uInvM.value.copy(e.mesh.matrix).invert();
      e.mat.uniforms.uCenterY.value = hgt;
      const fs = floorSets[p.cell];
      e.mat.uniforms.uFloorOrm.value = fs.ormMap;
      e.mat.uniforms.uFloorRoughF.value = info.roughF;
      e.mat.uniforms.uBounds.value.copy(info.bounds);
      e.mat.uniforms.uFade.value = 0.25 + 0.35 * (1 - info.roughF);
    }
  }
}
