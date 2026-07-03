// Unified analytic occluders (docs/unified-occluders.md): dynamic props are
// approximated by small sphere sets that reflection rays test INSIDE the
// portal traversal, before the cell walls. Subtractive only - multiple hits
// saturate toward full occlusion, so no depth sorting. Spheres are
// rotation-invariant: fitted once in prop-local space, transformed by the
// prop matrix per frame, so any resting or tumbling orientation is correct.
//
// Data lives in a small std140 uniform block, per-cell contiguous:
//   uOccCell[cell]  = (firstProp, propCount, -, -)
//   uOccBound[prop] = world bounding sphere (reject test)
//   uOccMeta[prop]  = (firstSphere, sphereCount, -, -)
//   uOccSph[i]      = world shape sphere
import * as THREE from 'three';

export const MAX_OCC_PROPS = 24;
export const MAX_SPHERES = 96;
export const MAX_PER_CELL = 8;
export const MAX_SPH_PER_PROP = 5;

export function buildOccluderGroup(numCells) {
  const group = new THREE.UniformsGroup();
  group.setName('OccluderData');
  group.setUsage(THREE.DynamicDrawUsage);
  // one Uniform per vec4 slot (see HullData note in materials.js)
  const mk = n => {
    const arr = [];
    for (let i = 0; i < n; i++) {
      const u = new THREE.Uniform(new THREE.Vector4());
      arr.push(u);
      group.add(u);
    }
    return arr;
  };
  return {
    group,
    numCells,
    cell: mk(numCells),
    bound: mk(MAX_OCC_PROPS),
    meta: mk(MAX_OCC_PROPS),
    sph: mk(MAX_SPHERES),
  };
}

// Automatic fit: one sphere per submesh bounding box, elongated boxes split
// into a chain of 2-3 along the long axis. Local space; largest 5 kept.
// (Hero statics get a manual authoring pass later - see the design doc.)
function fitSpheres(root) {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const v = new THREE.Vector3();
  const out = [];
  root.traverse(o => {
    if (!o.isMesh) return;
    o.geometry.computeBoundingBox();
    const bb = o.geometry.boundingBox;
    const m = new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld);
    const min = new THREE.Vector3(Infinity, Infinity, Infinity);
    const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    for (let i = 0; i < 8; i++) {
      v.set(i & 1 ? bb.max.x : bb.min.x, i & 2 ? bb.max.y : bb.min.y, i & 4 ? bb.max.z : bb.min.z)
        .applyMatrix4(m);
      min.min(v); max.max(v);
    }
    const ext = new THREE.Vector3().subVectors(max, min);
    const ctr = new THREE.Vector3().addVectors(min, max).multiplyScalar(0.5);
    const axes = ['x', 'y', 'z'].sort((a, b) => ext[b] - ext[a]);
    const L = axes[0], a = ext[axes[1]], b = ext[axes[2]];
    const ratio = ext[L] / Math.max(Math.max(a, b), 1e-3);
    if (ratio > 1.7) {
      // chain along the long axis: cross-section-sized spheres
      const k = Math.min(3, Math.round(ratio));
      const r = 0.5 * Math.hypot(a, b) * 0.9;
      for (let i = 0; i < k; i++) {
        const c = ctr.clone();
        c[L] = min[L] + r + (ext[L] - 2 * r) * (k > 1 ? i / (k - 1) : 0.5);
        out.push({ c, r });
      }
    } else {
      out.push({ c: ctr.clone(), r: 0.5 * ext.length() * 0.85 });
    }
  });
  out.sort((p, q) => q.r - p.r);
  return out.slice(0, MAX_SPH_PER_PROP);
}

export class OccluderSystem {
  constructor(occ, props) {
    this.occ = occ;
    this.entries = [];
    this.sv = new THREE.Vector3();
    for (const p of props.list) {
      if (p.debugPane) continue; // clear glass occludes nothing
      const spheres = fitSpheres(p.mesh);
      if (spheres.length) {
        const id = this.entries.length;
        this.entries.push({ p, id, spheres, world: spheres.map(() => new THREE.Vector4()) });
        // a prop's own reflection rays start inside its occluder set: tag its
        // materials so the shader skips self (uOccMeta.z carries the id)
        for (const m of p.mats) {
          if (m.uniforms && m.uniforms.uOccSelf) m.uniforms.uOccSelf.value = id;
        }
      }
    }
  }

  update() {
    const occ = this.occ;
    const byCell = new Map();
    for (const e of this.entries) {
      const mesh = e.p.mesh;
      if (!mesh.visible) continue;
      const mw = mesh.matrixWorld;
      const scale = mw.getMaxScaleOnAxis();
      for (let i = 0; i < e.spheres.length; i++) {
        const s = e.spheres[i];
        this.sv.copy(s.c).applyMatrix4(mw);
        e.world[i].set(this.sv.x, this.sv.y, this.sv.z, s.r * scale);
      }
      let list = byCell.get(e.p.cell);
      if (!list) byCell.set(e.p.cell, list = []);
      list.push(e);
    }
    let pi = 0, si = 0;
    for (let c = 0; c < occ.numCells; c++) {
      const list = byCell.get(c);
      const first = pi;
      let count = 0;
      if (list) {
        for (const e of list) {
          if (count >= MAX_PER_CELL || pi >= MAX_OCC_PROPS ||
              si + e.world.length > MAX_SPHERES) break;
          // prop-level bounding sphere from the world shape spheres
          let cx = 0, cy = 0, cz = 0;
          for (const w of e.world) { cx += w.x; cy += w.y; cz += w.z; }
          const n = e.world.length;
          cx /= n; cy /= n; cz /= n;
          let rb = 0;
          for (const w of e.world) {
            rb = Math.max(rb, Math.hypot(w.x - cx, w.y - cy, w.z - cz) + w.w);
          }
          occ.bound[pi].value.set(cx, cy, cz, rb);
          occ.meta[pi].value.set(si, n, e.id, 0);
          for (const w of e.world) occ.sph[si++].value.copy(w);
          pi++;
          count++;
        }
      }
      occ.cell[c].value.set(first, count, 0, 0);
    }
  }
}
