// Classic cell-and-portal visibility culling: start from the camera's cell
// with the full screen rect; a neighbor cell is visible only if one of its
// portals' projected NDC bounds intersects the current rect, and recursion
// continues with the INTERSECTION (frustum narrowing through each doorway).
// The portal graph doubles as a PVS, Quake-style.
//
// Uniquely safe here: reflections/GI read the baked atlas, not live geometry,
// so hiding off-screen cells can never break a mirror or a probe.
import * as THREE from 'three';
import { findCell } from './level.js';

const mvp = new THREE.Matrix4();
const MARGIN = 0.06; // NDC slack: 1-frame-stale XR matrices + snap turns

export class PortalCuller {
  constructor(level) {
    this.level = level;
    this.lastCell = 0;
    this.visible = new Set();
    this.enabled = true;
  }

  compute(camera, camPos) {
    const cells = this.level.cells;
    this.lastCell = findCell(cells, camPos, this.lastCell);
    mvp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const e = mvp.elements;
    const vis = this.visible;
    vis.clear();
    const rects = new Map();
    const stack = [{ cell: this.lastCell, rect: [-1.05, -1.05, 1.05, 1.05] }];
    let guard = 0;
    while (stack.length && guard++ < 64) {
      const { cell, rect } = stack.pop();
      vis.add(cell);
      for (const po of cells[cell].portals) {
        let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9, behind = 0;
        for (const c of po.corners) {
          const w = e[3] * c.x + e[7] * c.y + e[11] * c.z + e[15];
          if (w < 0.02) { behind++; continue; }
          const x = (e[0] * c.x + e[4] * c.y + e[8] * c.z + e[12]) / w;
          const y = (e[1] * c.x + e[5] * c.y + e[9] * c.z + e[13]) / w;
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
        let r;
        if (behind === 4) continue;          // fully behind the eye
        if (behind > 0) r = rect.slice();     // straddling: conservative pass-through
        else {
          r = [Math.max(rect[0], minX - MARGIN), Math.max(rect[1], minY - MARGIN),
               Math.min(rect[2], maxX + MARGIN), Math.min(rect[3], maxY + MARGIN)];
          if (r[0] >= r[2] || r[1] >= r[3]) continue; // portal outside the rect
        }
        const nb = po.neighbor;
        const prev = rects.get(nb);
        if (prev && prev[0] <= r[0] && prev[1] <= r[1] && prev[2] >= r[2] && prev[3] >= r[3]) continue;
        const merged = prev
          ? [Math.min(prev[0], r[0]), Math.min(prev[1], r[1]), Math.max(prev[2], r[2]), Math.max(prev[3], r[3])]
          : r;
        rects.set(nb, merged);
        stack.push({ cell: nb, rect: merged });
      }
    }
  }

  // toggle mesh visibility; during bakes everything must render (captures
  // see the whole scene from cell centers, not from the player)
  apply(staticGroup, props, baking) {
    if (!this.enabled || baking) {
      for (const m of staticGroup.children) m.visible = true;
      for (const p of props.list) p.mesh.visible = true;
      return;
    }
    const vis = this.visible;
    for (const m of staticGroup.children) m.visible = vis.has(m.userData.cell);
    for (const p of props.list) p.mesh.visible = vis.has(p.cell) || !!props.holderKey(p);
  }
}
