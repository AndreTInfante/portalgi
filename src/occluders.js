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

export const MAX_OCC_PROPS = 40;
export const MAX_SPHERES = 160;
export const MAX_PER_CELL = 10;
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
  // add() order defines the std140 layout: must match the GLSL block
  return {
    group,
    numCells,
    cell: mk(numCells),
    bound: mk(MAX_OCC_PROPS),
    meta: mk(MAX_OCC_PROPS),
    color: mk(MAX_OCC_PROPS),
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

// vertex-band fit for big merged static meshes (statue + plinth are one
// geometry): k spheres stacked along the longest bbox axis, radii from
// percentile-trimmed extents per band so outliers don't inflate them
function fitSpheresVerts(mesh, k = 3) {
  const pos = mesh.geometry.getAttribute('position');
  const v = new THREE.Vector3();
  const pts = [];
  const step = Math.max(1, Math.floor(pos.count / 900));
  for (let i = 0; i < pos.count; i += step) {
    pts.push(v.fromBufferAttribute(pos, i).toArray());
  }
  mesh.geometry.computeBoundingBox();
  const bb = mesh.geometry.boundingBox;
  const ext = new THREE.Vector3().subVectors(bb.max, bb.min);
  const A = ['x', 'y', 'z'].sort((a, b) => ext[b] - ext[a])[0];
  const ai = { x: 0, y: 1, z: 2 }[A];
  const out = [];
  for (let b = 0; b < k; b++) {
    const lo = bb.min[A] + (ext[A] * b) / k;
    const hi = bb.min[A] + (ext[A] * (b + 1)) / k;
    const band = pts.filter(p => p[ai] >= lo && p[ai] <= hi);
    if (band.length < 8) continue;
    const c = [0, 0, 0];
    for (const p of band) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
    c[0] /= band.length; c[1] /= band.length; c[2] /= band.length;
    const ds = band.map(p => Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2])).sort((x, y) => x - y);
    const r = ds[Math.floor(ds.length * 0.9)]; // 90th percentile reach
    out.push({ c: new THREE.Vector3(...c), r: Math.max(r, 0.1) });
  }
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
        // occluder blob color ~ the prop's diffuse albedo (procedural textures
        // carry a linear average; model textures fall back to a neutral)
        const t = p.mats[0] && p.mats[0].uniforms.uTint ? p.mats[0].uniforms.uTint.value : null;
        const avg = p.mats[0] && p.mats[0].uniforms.uMap &&
          p.mats[0].uniforms.uMap.value && p.mats[0].uniforms.uMap.value.userData.avg;
        const col = avg && t ? [avg[0] * t.x, avg[1] * t.y, avg[2] * t.z]
          : t ? [t.x * 0.5, t.y * 0.5, t.z * 0.5] : [0.35, 0.33, 0.3];
        const id = this.entries.length;
        this.entries.push({
          p, id, spheres, col,
          world: spheres.map(() => new THREE.Vector4()),
        });
        // a prop's own reflection rays start inside its occluder set: tag its
        // materials so the shader skips self (uOccMeta.z carries the id)
        for (const m of p.mats) {
          if (m.uniforms && m.uniforms.uOccSelf) m.uniforms.uOccSelf.value = id;
        }
      }
    }
    this.statics = []; // furniture/statues: world-space, packed as-is
  }

  // static exhibit mesh (world-space geometry): vertex-band sphere fit
  addStatic(mesh, cellId, col) {
    const spheres = fitSpheresVerts(mesh);
    if (!spheres.length) return;
    this.statics.push({
      cell: cellId, col,
      world: spheres.map(s => new THREE.Vector4(s.c.x, s.c.y, s.c.z, s.r)),
    });
  }

  // authored box-ish furniture (benches/pedestals from the collider registry):
  // sphere chain along the longest of (2rx, h, 2rz), yaw-rotated
  addBox(x, z, rot, rx, rz, h, cellId, col) {
    const dims = [2 * rx, h, 2 * rz];
    const L = dims.indexOf(Math.max(...dims));
    const short = dims.filter((_, i) => i !== L);
    const r = 0.5 * Math.hypot(short[0], short[1]) * 0.9;
    const k = Math.max(1, Math.min(3, Math.round(dims[L] / Math.max(2 * r, 1e-3))));
    const cos = Math.cos(rot), sin = Math.sin(rot);
    const world = [];
    for (let i = 0; i < k; i++) {
      const f = k > 1 ? i / (k - 1) : 0.5;
      const off = -dims[L] / 2 + r + (dims[L] - 2 * r) * f;
      let lx = 0, ly = h / 2, lz = 0;
      if (L === 0) lx = off; else if (L === 1) ly = h / 2 + off; else lz = off;
      world.push(new THREE.Vector4(x + lx * cos - lz * sin, ly, z + lx * sin + lz * cos, r));
    }
    this.statics.push({ cell: cellId, col, world });
  }

  update() {
    const occ = this.occ;
    const byCell = new Map();
    const push = (cellId, item) => {
      let list = byCell.get(cellId);
      if (!list) byCell.set(cellId, list = []);
      list.push(item);
    };
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
      push(e.p.cell, { world: e.world, col: e.col, id: e.id });
    }
    // statics: ids from 1000 so no prop material's uOccSelf (or the static
    // materials' -1 default) can ever match one
    for (let i = 0; i < this.statics.length; i++) {
      const s = this.statics[i];
      push(s.cell, { world: s.world, col: s.col, id: 1000 + i });
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
          // entry-level bounding sphere from the world shape spheres
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
          occ.color[pi].value.set(e.col[0], e.col[1], e.col[2], 0);
          for (const w of e.world) occ.sph[si++].value.copy(w);
          pi++;
          count++;
        }
      }
      occ.cell[c].value.set(first, count, 0, 0);
    }
  }
}
