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
import { OCCLUDER_PROXIES } from './proxies.js';

// [[ax,ay,az],[bx,by,bz],r] -> {a: Vector3, b: Vector3, r}
const capsFromData = data => data.map(([a, b, r]) => ({
  a: new THREE.Vector3(...a), b: new THREE.Vector3(...b), r,
}));
// authored statics live in a grounded/unrotated local frame (proxies.js):
// world = T(x, 0, z) * R(rotY) * local
const capToWorld = (v, f) => {
  const c = Math.cos(f.rotY), s = Math.sin(f.rotY);
  return new THREE.Vector3(f.x + c * v.x + s * v.z, v.y, f.z - s * v.x + c * v.z);
};

// TOTAL SIZE IS A PLATFORM CONSTRAINT, not a tuning knob: raising the block
// to ~15.7KB total UBO (with HullData) regressed EVERY on-device config
// incl. steps0, which runs none of the occluder code - consistent with
// Adreno demoting all uniform-block reads to the slow path once the fast
// constant store overflows. ~13KB total measured good. Capacity within the
// budget comes from packing only VISIBLE cells (+ portal neighbors) per
// frame instead of reserving slots for the whole level: the same bytes now
// support 16 entries/cell and 8 capsules/entry in the rooms that matter.
export const MAX_OCC_PROPS = 40;
export const MAX_SPHERES = 160; // vec4 slots: 80 capsules
export const MAX_PER_CELL = 16;
export const MAX_SPH_PER_PROP = 8;

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
  // add() order defines the std140 layout: must match the GLSL block.
  // firstSphere/count/group pack into color.w (17 bits, float-exact).
  // NOTE: no cell-level aggregate volume - entries touch the floor, so any
  // aggregate containing them contains the floor, and floor-origin rays
  // (the dominant fill) intersect it at t=0. It can never reject them.
  return {
    group,
    numCells,
    cell: mk(numCells),
    bound: mk(MAX_OCC_PROPS),
    color: mk(MAX_OCC_PROPS),
    sph: mk(MAX_SPHERES),
  };
}

// Automatic fit: one CAPSULE per submesh bounding box - elongated boxes get
// a single stretched capsule along the long axis, compact ones degenerate to
// a sphere (a == b). Local space; largest 5 kept.
// (Hero statics get a manual authoring pass later - see the design doc.)
export function fitCapsules(root) {
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
    const L = axes[0], sa = ext[axes[1]], sb = ext[axes[2]];
    const ratio = ext[L] / Math.max(Math.max(sa, sb), 1e-3);
    // radii from the max EXTENT, not the bbox diagonal - the diagonal made a
    // sphere prop's occluder 1.47x the ball (phantom poking through the floor)
    if (ratio > 1.4) {
      const r = 0.55 * Math.max(sa, sb);
      const a = ctr.clone(), b = ctr.clone();
      a[L] = Math.min(min[L] + r, ctr[L]);
      b[L] = Math.max(max[L] - r, ctr[L]);
      out.push({ a, b, r });
    } else {
      const c = ctr.clone();
      out.push({ a: c, b: c.clone(), r: 0.5 * Math.max(ext.x, ext.y, ext.z) * 0.95 });
    }
  });
  out.sort((p, q) => q.r - p.r);
  return out.slice(0, MAX_SPH_PER_PROP);
}

// vertex-band fit for big merged static meshes (statue + plinth are one
// geometry): k spheres stacked along the longest bbox axis, radii from
// percentile-trimmed extents per band so outliers don't inflate them
function fitCapsulesVerts(mesh, k = 3) {
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
    const cv = new THREE.Vector3(...c);
    out.push({ a: cv, b: cv.clone(), r: Math.max(r, 0.1) });
  }
  return out.slice(0, MAX_SPH_PER_PROP);
}

export class OccluderSystem {
  constructor(occ, props) {
    this.occ = occ;
    this.entries = [];
    this.sv = new THREE.Vector3();
    this._nextGroup = 1;
    for (const p of props.list) {
      if (p.debugPane) continue; // clear glass occludes nothing
      // authored prop-local proxies beat the auto-fit (proxies.js)
      const authored = p.slug && OCCLUDER_PROXIES.props[p.slug];
      const spheres = authored ? capsFromData(authored.capsules) : fitCapsules(p.mesh);
      if (spheres.length) {
        // occluder blob color: authored albedo, else the prop's diffuse
        // estimate (procedural textures carry a linear average; model
        // textures fall back to a neutral)
        const t = p.mats[0] && p.mats[0].uniforms.uTint ? p.mats[0].uniforms.uTint.value : null;
        const avg = p.mats[0] && p.mats[0].uniforms.uMap &&
          p.mats[0].uniforms.uMap.value && p.mats[0].uniforms.uMap.value.userData.avg;
        const col = (authored && authored.color) ? authored.color
          : avg && t ? [avg[0] * t.x, avg[1] * t.y, avg[2] * t.z]
          : t ? [t.x * 0.5, t.y * 0.5, t.z * 0.5] : [0.35, 0.33, 0.3];
        // occlusion group: "an occluder never occludes the surfaces it
        // approximates". All of a prop's materials share one group
        const group = this._nextGroup++;
        for (const m of p.mats) {
          if (m.uniforms && m.uniforms.uOccSelf) m.uniforms.uOccSelf.value = group;
        }
        this.entries.push({
          p, group, spheres, col,
          // two vec4 slots per capsule: (a, r) and (b, spare)
          world: spheres.map(() => [new THREE.Vector4(), new THREE.Vector4()]),
        });
      }
    }
    this.statics = []; // furniture/statues: world-space, packed as-is
  }

  // group id for a material (assigning one on first sight); entries carrying
  // this group are skipped for pixels shaded by this material. Shared
  // materials (all walnut furniture in a cell) share one group - a bench
  // seat skips every walnut piece, which costs only furniture-on-furniture
  // reflections. Materials without groups (floors, walls) skip nothing.
  _groupOf(mat) {
    if (!mat || !mat.uniforms || !mat.uniforms.uOccSelf) return 0;
    if (mat.uniforms.uOccSelf.value < 1) mat.uniforms.uOccSelf.value = this._nextGroup++;
    return mat.uniforms.uOccSelf.value;
  }

  // static exhibit mesh (world-space geometry): authored local-frame proxies
  // (proxies.js, transformed by the def's proxyFrame) beat the vertex-band fit
  addStatic(mesh, cellId, col) {
    const authored = mesh.userData.slug && OCCLUDER_PROXIES.statics[mesh.userData.slug];
    // statues load as multiple submeshes, one addStatic each: an authored
    // slug registers ONCE, and later submeshes join the first entry's group
    // (else each submesh gets occluded/AO'd by its twin's identical capsules)
    if (authored) {
      const existing = this.statics.find(s => s.slug === mesh.userData.slug);
      if (existing) {
        if (mesh.material.uniforms && mesh.material.uniforms.uOccSelf) {
          mesh.material.uniforms.uOccSelf.value = existing.group;
        }
        return;
      }
    }
    let caps;
    if (authored) {
      const f = mesh.userData.proxyFrame || { x: 0, z: 0, rotY: 0 };
      caps = capsFromData(authored.capsules).map(c => ({
        a: capToWorld(c.a, f), b: capToWorld(c.b, f), r: c.r,
      }));
      if (authored.color) col = authored.color;
    } else {
      caps = fitCapsulesVerts(mesh);
    }
    if (!caps.length) return;
    this.statics.push({
      cell: cellId, col, group: this._groupOf(mesh.material),
      slug: mesh.userData.slug,
      world: caps.map(s => [
        new THREE.Vector4(s.a.x, s.a.y, s.a.z, s.r),
        new THREE.Vector4(s.b.x, s.b.y, s.b.z, 0),
      ]),
    });
  }

  // authored furniture piece: a list of world-space capsules [a, b, r] that
  // stays ONE entry (tight bounding sphere keeps the reject test effective);
  // mat = the material whose surfaces this piece approximates
  addPiece(capsules, cellId, col, mat) {
    this.statics.push({
      cell: cellId, col, group: this._groupOf(mat),
      world: capsules.slice(0, MAX_SPH_PER_PROP).map(([a, b, r]) => [
        new THREE.Vector4(a[0], a[1], a[2], r),
        new THREE.Vector4(b[0], b[1], b[2], 0),
      ]),
    });
  }

  // activeCells: the culler's visible set, or null for all (bakes, cull=0).
  // Only cells a reflection ray can actually start in (visible) or reach in
  // one hop (their portal neighbors, precomputed by the caller) need slots
  // this frame - that is what buys 16 entries/cell inside the UBO budget.
  update(activeCells) {
    const occ = this.occ;
    const byCell = new Map();
    const push = (cellId, item) => {
      if (activeCells && !activeCells.has(cellId)) return;
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
        this.sv.copy(s.a).applyMatrix4(mw);
        e.world[i][0].set(this.sv.x, this.sv.y, this.sv.z, s.r * scale);
        this.sv.copy(s.b).applyMatrix4(mw);
        e.world[i][1].set(this.sv.x, this.sv.y, this.sv.z, 0);
      }
      // dyn: props pack at the HEAD of each cell's list so the shadow rays
      // can march just them (uOccCell.z) - statics' shadows are baked
      push(e.p.cell, { world: e.world, col: e.col, group: e.group, dyn: true });
    }
    for (const s of this.statics) {
      push(s.cell, { world: s.world, col: s.col, group: s.group });
    }
    let pi = 0, si = 0;
    for (let c = 0; c < occ.numCells; c++) {
      const list = byCell.get(c);
      const first = pi;
      let count = 0, dynCount = 0;
      if (list) {
        for (const e of list) {
          if (count >= MAX_PER_CELL || pi >= MAX_OCC_PROPS ||
              si + e.world.length * 2 > MAX_SPHERES) break;
          // entry-level bounding sphere over both capsule endpoints
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
          occ.bound[pi].value.set(cx, cy, cz, rb);
          // color.w packs group (6b) | sphereCount (3b) | firstSlot (rest)
          occ.color[pi].value.set(e.col[0], e.col[1], e.col[2],
            e.group + n * 64 + si * 512);
          for (const [wa, wb] of e.world) {
            occ.sph[si++].value.copy(wa);
            occ.sph[si++].value.copy(wb);
          }
          pi++;
          count++;
          if (e.dyn) dynCount++;
        }
      }
      occ.cell[c].value.set(first, count, dynCount, 0);
    }
  }
}
