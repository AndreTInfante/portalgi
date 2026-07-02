// Planar reflection smudges for dynamic props: the baked atlas can never show
// moving objects, so mirror a low-poly convex-hull imposter of each prop
// beneath reflective floors (real geometry -> correct stereo depth in VR).
//
// - Floor materials write stencil bit 1 where the floor is the visible
//   surface; imposters render depthTest-off but stencil-tested, so they can
//   never bleed onto occluders (pedestals, props, walls).
// - Vertex inflation grows with distance behind the plane (linearized GGX
//   cone, same distance-roughness convention as the traversal).
// - Alpha: inverse rim (soft silhouette) x distance falloff x the floor's
//   ACTUAL roughness map sampled in floor-plane UV (the smudge breaks up
//   exactly where the visible floor does) x fresnel of the floor at the
//   grazing angle (so it strengthens like the atlas reflection next to it).
import * as THREE from 'three';
import { ConvexGeometry } from '../libs/geometries/ConvexGeometry.js';

const REFLECTIVE_MAX_ROUGHFACTOR = 0.75; // floors glossier than this get smudges

const VERT = /* glsl */`
uniform float uInflate;
varying vec3 vWorld;
varying vec3 vNrm;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec3 wn = normalize(mat3(modelMatrix) * normal);
  float db = max(-wp.y, 0.0);          // all reflective floors sit at y=0
  wp.xyz += wn * uInflate * db;        // widening blur cone with depth
  vWorld = wp.xyz;
  vNrm = wn;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FRAG = /* glsl */`
precision highp float;
uniform vec3 uColor;
uniform float uOpacity;
uniform float uFade;
uniform float uRimPow;
uniform sampler2D uFloorOrm;
uniform float uFloorRoughF;
uniform vec4 uBounds;     // cell floor bbox: minX, minZ, maxX, maxZ
uniform float uExposure;
varying vec3 vWorld;
varying vec3 vNrm;
vec3 acesTonemap(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}
void main() {
  if (vWorld.x < uBounds.x || vWorld.z < uBounds.y ||
      vWorld.x > uBounds.z || vWorld.z > uBounds.w) discard; // clip to this cell's floor
  float db = max(-vWorld.y, 0.0);
  vec3 V = normalize(cameraPosition - vWorld);
  float rim = abs(dot(normalize(vNrm), V));
  // fresnel of the FLOOR at the point the eye reads this smudge through
  vec3 floorP = vec3(vWorld.x, 0.0, vWorld.z);
  vec3 Vf = normalize(cameraPosition - floorP);
  float F = 0.05 + 0.95 * pow(1.0 - max(Vf.y, 0.0), 5.0);
  float rgh = texture(uFloorOrm, vWorld.xz * 0.35).g * uFloorRoughF;
  float a = uOpacity
          * pow(rim, uRimPow)
          * exp(-db / uFade)
          * clamp(1.35 - rgh * 1.6, 0.0, 1.0)
          * F;
  vec3 c = pow(acesTonemap(uColor * uExposure), vec3(1.0 / 2.2)); // match scene output space
  gl_FragColor = vec4(c, clamp(a, 0.0, 1.0));
}
`;

// subsample an Object3D's mesh vertices (world-of-root space) for hulling
function collectPoints(root, cap = 220) {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const pts = [];
  root.traverse(o => {
    if (!o.isMesh) return;
    const pos = o.geometry.getAttribute('position');
    const m = new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld);
    const step = Math.max(1, Math.floor(pos.count / cap));
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i += step) {
      pts.push(v.fromBufferAttribute(pos, i).applyMatrix4(m).clone());
    }
  });
  return pts;
}

const S_MIRROR = new THREE.Matrix4().makeScale(1, -1, 1); // reflect about y=0

export class ReflectionSystem {
  constructor(scene, level, props, globals) {
    this.level = level;
    this.props = props;
    this.enabled = true;
    this.group = new THREE.Group();
    scene.add(this.group);

    // which cells have a reflective floor, + their params
    this.cellInfo = level.cells.map(c => {
      const reflective = c.floor.roughFactor <= REFLECTIVE_MAX_ROUGHFACTOR;
      const xs = c.fp.map(p => p[0]), zs = c.fp.map(p => p[1]);
      return reflective ? {
        bounds: new THREE.Vector4(Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)),
        roughF: c.floor.roughFactor,
      } : null;
    });

    this.globals = globals;
    this.staticImposters = false; // A/B toggle: statics via imposter vs baked capture
    this.entries = [];
    for (const p of props.list) {
      const tint = p.mats[0] && p.mats[0].uniforms.uTint ? p.mats[0].uniforms.uTint.value : { x: 0.5, y: 0.5, z: 0.5 };
      this._makeEntry(p, tint, false);
    }
  }

  // lightmapped static exhibits (geometry already in world space)
  addStatic(mesh) {
    this._makeEntry(
      { mesh, cell: mesh.userData.cell, mats: [] },
      { x: 0.45, y: 0.43, z: 0.4 }, true);
  }

  _makeEntry(p, tint, isStatic) {
    {
      let geo;
      try {
        geo = new ConvexGeometry(collectPoints(p.mesh));
      } catch (e) {
        geo = new THREE.SphereGeometry(p.radius || 0.5, 12, 8);
      }
      const mat = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: VERT,
        fragmentShader: 'layout(location=0) out vec4 fragOut;\n#define gl_FragColor fragOut\n' + FRAG,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,          // mirrored transform flips winding
        stencilWrite: true,              // enables the stencil unit...
        stencilWriteMask: 0,             // ...but never writes
        stencilFunc: THREE.EqualStencilFunc,
        stencilRef: 1,
        uniforms: {
          uInflate: { value: 0.22 },
          uColor: { value: new THREE.Vector3(tint.x * 0.5, tint.y * 0.5, tint.z * 0.5) },
          uOpacity: { value: 0.8 },
          uFade: { value: 1.6 },
          uRimPow: { value: 1.4 },
          uFloorOrm: { value: null },
          uFloorRoughF: { value: 1 },
          uBounds: { value: new THREE.Vector4() },
          uExposure: this.globals.uExposure, // shared identity with the scene
        },
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.matrixAutoUpdate = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 5; // after opaque scene, with the transparents
      mesh.layers.set(3);   // never in bake captures
      mesh.visible = false;
      this.group.add(mesh);
      this.entries.push({ prop: p, mesh, mat, isStatic });
    }
  }

  // floorSets: cellId -> { ormMap, roughFactor } (from the material system)
  update(floorSets, visibleCells) {
    for (const e of this.entries) {
      const p = e.prop;
      const info = this.enabled ? this.cellInfo[p.cell] : null;
      const show = !!info && p.mesh.visible && (!e.isStatic || this.staticImposters)
        && (!visibleCells || visibleCells.has(p.cell));
      e.mesh.visible = show;
      if (!show) continue;
      p.mesh.updateMatrixWorld(true);
      e.mesh.matrix.copy(p.mesh.matrixWorld).premultiply(S_MIRROR);
      const fs = floorSets[p.cell];
      e.mat.uniforms.uFloorOrm.value = fs.ormMap;
      e.mat.uniforms.uFloorRoughF.value = info.roughF;
      e.mat.uniforms.uBounds.value.copy(info.bounds);
      e.mat.uniforms.uFade.value = 0.6 + 1.6 * (1 - info.roughF); // glossier floor = longer smudge
      e.mat.uniforms.uInflate.value = 0.1 + 0.35 * info.roughF;   // rougher floor = wider cone
    }
  }
}
