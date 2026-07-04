// Packs the cell/portal graph into an RGBA32F DataTexture for the traversal shader.
//
// Row y = cell id. Texel layout along x:
//   0            : capture.xyz, planeCount
//   1            : portalCount, floorY, ceilY, portal-plane bitmask (bit j =
//                  plane j carries a portal; exits onto other planes skip the
//                  whole portal scan)
//   2 .. 13      : hull planes (n.xyz, d), inside = dot(n,p)+d > 0
//   14 + p*5 + 0 : portal p: planeIndex, neighborCell, isVirtual, silhouette-edge bitmask
//   14 + p*5 + 1..4 : portal edge planes (n.xyz, d), >0 inside the portal polygon
//   34           : probe grid bbox min.xyz, dims.x
//   35           : probe grid bbox size.xyz, dims.y
//   36           : dims.z, 0, 0, 0
import * as THREE from 'three';

export const HULL_TEX_W = 40;
export const MAX_PLANES = 12;
export const MAX_PORTALS = 4;
export const PLANES_OFF = 2;
export const PORTALS_OFF = 14;
export const PORTAL_STRIDE = 5;
export const PROBE_META_OFF = 34;

export function buildHullTexture(cells) {
  const w = HULL_TEX_W, h = cells.length;
  const data = new Float32Array(w * h * 4);
  const put = (cell, texel, x, y, z, ww) => {
    const i = (cell * w + texel) * 4;
    data[i] = x; data[i + 1] = y; data[i + 2] = z; data[i + 3] = ww;
  };
  for (const cell of cells) {
    if (cell.planes.length > MAX_PLANES) throw new Error(`${cell.name}: ${cell.planes.length} planes > ${MAX_PLANES}`);
    if (cell.portals.length > MAX_PORTALS) throw new Error(`${cell.name}: ${cell.portals.length} portals > ${MAX_PORTALS}`);
    put(cell.id, 0, cell.capture.x, cell.capture.y, cell.capture.z, cell.planes.length);
    const planeMask = cell.portals.reduce((m, po) => m | (1 << po.planeIndex), 0);
    put(cell.id, 1, cell.portals.length, cell.floorY, cell.ceilY, planeMask);
    cell.planes.forEach((pl, j) => put(cell.id, PLANES_OFF + j, pl.n.x, pl.n.y, pl.n.z, pl.d));
    cell.portals.forEach((po, p) => {
      const base = PORTALS_OFF + p * PORTAL_STRIDE;
      put(cell.id, base, po.planeIndex, po.neighbor, po.virtual ? 1 : 0, po.blendMask);
      po.edgePlanes.forEach((ep, e) => put(cell.id, base + 1 + e, ep.n.x, ep.n.y, ep.n.z, ep.d));
    });
    const pg = cell.probeGrid;
    put(cell.id, PROBE_META_OFF, pg.min[0], pg.min[1], pg.min[2], pg.dims[0]);
    put(cell.id, PROBE_META_OFF + 1, pg.size[0], pg.size[1], pg.size[2], pg.dims[1]);
    put(cell.id, PROBE_META_OFF + 2, pg.dims[2], 0, 0, 0);
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.FloatType);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  // the scene shader reads this same stream from a std140 uniform block
  // (constant-register reads beat dependent texelFetches in the hot loop);
  // bake-side shaders keep the texture path
  tex.userData.array = data;
  return tex;
}
