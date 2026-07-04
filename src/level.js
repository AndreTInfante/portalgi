// Level authoring + convex hull / portal graph construction + mesh building.
//
// Conventions:
//  - y is up. Cell footprints are convex polygons in the xz plane, extruded floorY..ceilY.
//  - Hull planes: inside test is dot(n, p) + d > 0 (n points into the cell).
//  - Portals are rectangles lying on a hull plane; each side cell gets its own record.
//  - Rooms connected by doorways are separated by WALL_T of wall thickness; the door
//    jamb geometry lives in that gap (outside both hulls -- deliberately, to test
//    robustness of traversal entry from slightly-outside points).
import * as THREE from 'three';
import { PAINTINGS } from './textures.js';

export const WALL_T = 0.3;

// ---------------------------------------------------------------- geometry builder

const V = {
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  len: a => Math.hypot(a[0], a[1], a[2]),
  norm: a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
  mad: (p, d, s) => [p[0] + d[0] * s, p[1] + d[1] * s, p[2] + d[2] * s],
};

// Emits triangles plus lightmap CHARTS: every quad/polygon gets its own chart
// with planar local coords; packLightmapCharts() later assigns atlas rects and
// writes the uv2 attribute.
export class GeoBuilder {
  constructor() {
    this.pos = []; this.nrm = []; this.uv = []; this.lc = []; this.tan = [];
    this.charts = []; // { w, h (meters), start (vertex index), count }
    this.uv2 = null;  // Float32Array, filled by packLightmapCharts
  }
  _chart(w, h) {
    const ch = { w: Math.max(w, 0.05), h: Math.max(h, 0.05), start: this.pos.length / 3, count: 0 };
    this.charts.push(ch);
    return ch;
  }
  _vert(ch, p, n, uv, l) {
    this.pos.push(p[0], p[1], p[2]);
    this.nrm.push(n[0], n[1], n[2]);
    this.uv.push(uv[0], uv[1]);
    this.lc.push(l[0], l[1]);
    ch.count++;
  }
  _emitTri(ch, a, b, c, n, ua, ub, uc, la, lb, lcc) {
    this._vert(ch, a, n, ua, la);
    this._vert(ch, b, n, ub, lb);
    this._vert(ch, c, n, uc, lcc);
    // flat tangent from uv gradients (three normal-map convention, w=handedness)
    const e1 = V.sub(b, a), e2 = V.sub(c, a);
    const x1 = ub[0] - ua[0], y1 = ub[1] - ua[1];
    const x2 = uc[0] - ua[0], y2 = uc[1] - ua[1];
    const det = x1 * y2 - y1 * x2;
    let T = [1, 0, 0], w = 1;
    if (Math.abs(det) > 1e-9) {
      const r = 1 / det;
      T = V.norm([(e1[0] * y2 - e2[0] * y1) * r, (e1[1] * y2 - e2[1] * y1) * r, (e1[2] * y2 - e2[2] * y1) * r]);
      const B = [(e2[0] * x1 - e1[0] * x2) * r, (e2[1] * x1 - e1[1] * x2) * r, (e2[2] * x1 - e1[2] * x2) * r];
      w = V.dot(V.cross(n, T), B) < 0 ? -1 : 1;
    }
    for (let k = 0; k < 3; k++) this.tan.push(T[0], T[1], T[2], w);
  }
  tri(a, b, c, n, ua, ub, uc) {
    if (V.dot(V.cross(V.sub(b, a), V.sub(c, a)), n) < 0) { // wind to face the normal
      const tb = b; b = c; c = tb;
      const tu = ub; ub = uc; uc = tu;
    }
    const e1 = V.sub(b, a), e2 = V.sub(c, a);
    const u = V.norm(e1), v = V.norm(V.cross(n, u));
    const lb = [V.dot(e1, u), V.dot(e1, v)], lcc = [V.dot(e2, u), V.dot(e2, v)];
    const mx = Math.min(0, lb[0], lcc[0]), my = Math.min(0, lb[1], lcc[1]);
    const la = [-mx, -my];
    lb[0] -= mx; lb[1] -= my; lcc[0] -= mx; lcc[1] -= my;
    const ch = this._chart(Math.max(la[0], lb[0], lcc[0]), Math.max(la[1], lb[1], lcc[1]));
    this._emitTri(ch, a, b, c, n, ua, ub, uc, la, lb, lcc);
  }
  // 4 corners in ring order + desired normal; winding auto-fixed to face the normal.
  quad(p, n, uvs) {
    const e1 = V.sub(p[1], p[0]), e2 = V.sub(p[3], p[0]);
    const g = V.cross(e1, e2);
    const flip = V.dot(g, n) < 0;
    const idx = flip ? [0, 3, 2, 1] : [0, 1, 2, 3];
    const w = V.len(e1), h = V.len(e2);
    const loc = [[0, 0], [w, 0], [w, h], [0, h]];
    const q = idx.map(i => p[i]), u = idx.map(i => uvs[i]), l = idx.map(i => loc[i]);
    const ch = this._chart(w, h);
    this._emitTri(ch, q[0], q[1], q[2], n, u[0], u[1], u[2], l[0], l[1], l[2]);
    this._emitTri(ch, q[0], q[2], q[3], n, u[0], u[2], u[3], l[0], l[2], l[3]);
  }
  // convex polygon fan sharing ONE chart (no interior lightmap seams)
  polygon(pts, n, uvFn) {
    // Newell's method for the winding test: the first-three-points cross
    // product is degenerate when a footprint starts with collinear vertices
    // (e.g. L1's split south edge), which flipped its floor into a backface.
    let nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      nx += (a[1] - b[1]) * (a[2] + b[2]);
      ny += (a[2] - b[2]) * (a[0] + b[0]);
      nz += (a[0] - b[0]) * (a[1] + b[1]);
    }
    if (V.dot([nx, ny, nz], n) < 0) {
      pts = pts.slice().reverse(); // wind the fan to face the normal
    }
    const u = V.norm(V.sub(pts[1], pts[0]));
    const v = V.norm(V.cross(n, u));
    const loc = pts.map(p => [V.dot(V.sub(p, pts[0]), u), V.dot(V.sub(p, pts[0]), v)]);
    const mx = Math.min(...loc.map(l => l[0])), my = Math.min(...loc.map(l => l[1]));
    for (const l of loc) { l[0] -= mx; l[1] -= my; }
    const ch = this._chart(Math.max(...loc.map(l => l[0])), Math.max(...loc.map(l => l[1])));
    for (let i = 1; i < pts.length - 1; i++) {
      this._emitTri(ch, pts[0], pts[i], pts[i + 1], n,
        uvFn(pts[0]), uvFn(pts[i]), uvFn(pts[i + 1]), loc[0], loc[i], loc[i + 1]);
    }
  }
  box(cx, cy, cz, sx, sy, sz, uvScale = 1) {
    const x0 = cx - sx / 2, x1 = cx + sx / 2, y0 = cy - sy / 2, y1 = cy + sy / 2, z0 = cz - sz / 2, z1 = cz + sz / 2;
    const u = (a, b) => [[0, 0], [a * uvScale, 0], [a * uvScale, b * uvScale], [0, b * uvScale]];
    this.quad([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1], u(sx, sy));
    this.quad([[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], [0, 0, -1], u(sx, sy));
    this.quad([[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], [1, 0, 0], u(sz, sy));
    this.quad([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], [-1, 0, 0], u(sz, sy));
    this.quad([[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], [0, 1, 0], u(sx, sz));
    this.quad([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], [0, -1, 0], u(sx, sz));
  }
  // box with an arbitrary orthonormal basis (bx/by/bz unit vectors), size s
  orientedBox(c, bx, by, bz, s, uvScale = 1) {
    const hx = s[0] / 2, hy = s[1] / 2, hz = s[2] / 2;
    const corner = (i, j, k) => V.mad(V.mad(V.mad(c, bx, i * hx), by, j * hy), bz, k * hz);
    const face = (n, p00, p10, p11, p01, w, h) => {
      const uv = [[0, 0], [w * uvScale, 0], [w * uvScale, h * uvScale], [0, h * uvScale]];
      this.quad([p00, p10, p11, p01], n, uv);
    };
    face(bz, corner(-1, -1, 1), corner(1, -1, 1), corner(1, 1, 1), corner(-1, 1, 1), s[0], s[1]);
    face([-bz[0], -bz[1], -bz[2]], corner(1, -1, -1), corner(-1, -1, -1), corner(-1, 1, -1), corner(1, 1, -1), s[0], s[1]);
    face(bx, corner(1, -1, 1), corner(1, -1, -1), corner(1, 1, -1), corner(1, 1, 1), s[2], s[1]);
    face([-bx[0], -bx[1], -bx[2]], corner(-1, -1, -1), corner(-1, -1, 1), corner(-1, 1, 1), corner(-1, 1, -1), s[2], s[1]);
    face(by, corner(-1, 1, 1), corner(1, 1, 1), corner(1, 1, -1), corner(-1, 1, -1), s[0], s[2]);
    face([-by[0], -by[1], -by[2]], corner(-1, -1, -1), corner(1, -1, -1), corner(1, -1, 1), corner(-1, -1, 1), s[0], s[2]);
  }
  buildGeometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('tang4', new THREE.Float32BufferAttribute(this.tan, 4));
    // custom name: three treats 'uv2' specially per-geometry, which breaks
    // shared-shader compilation between charted meshes and chartless props
    if (this.uv2) g.setAttribute('lmuv', new THREE.BufferAttribute(this.uv2, 2));
    return g;
  }
  get empty() { return this.pos.length === 0; }
}

// Shelf-pack every chart of every builder into one lightmap atlas and write
// per-vertex uv2 (half-texel inset so bilinear stays inside the chart; the
// 2px pad ring gets filled by dilation after the bake).
export function packLightmapCharts(level, density = 16, atlasW = 1024) {
  const PAD = 2;
  const entries = [];
  for (const cell of level.cells) {
    for (const [, b] of cell.builders) {
      for (const ch of b.geo.charts) entries.push({ g: b.geo, ch });
    }
  }
  for (const e of entries) {
    e.pw = Math.min(atlasW - 2 * PAD, Math.max(2, Math.ceil(e.ch.w * density)));
    e.ph = Math.max(2, Math.ceil(e.ch.h * density));
  }
  entries.sort((a, b) => b.ph - a.ph);
  let x = 0, y = 0, shelf = 0;
  for (const e of entries) {
    const w = e.pw + 2 * PAD, h = e.ph + 2 * PAD;
    if (x + w > atlasW) { x = 0; y += shelf; shelf = 0; }
    e.x = x; e.y = y;
    x += w;
    shelf = Math.max(shelf, h);
  }
  const atlasH = Math.ceil((y + shelf) / 4) * 4;
  for (const e of entries) {
    const g = e.g;
    if (!g.uv2) g.uv2 = new Float32Array((g.pos.length / 3) * 2);
    for (let i = 0; i < e.ch.count; i++) {
      const vi = e.ch.start + i;
      const lx = g.lc[vi * 2] / e.ch.w, ly = g.lc[vi * 2 + 1] / e.ch.h;
      g.uv2[vi * 2] = (e.x + PAD + 0.5 + lx * (e.pw - 1)) / atlasW;
      g.uv2[vi * 2 + 1] = (e.y + PAD + 0.5 + ly * (e.ph - 1)) / atlasH;
    }
  }
  level.lightmapSize = [atlasW, atlasH];
}

// ---------------------------------------------------------------- authoring data

function rect(x0, z0, x1, z1) { return [[x0, z0], [x1, z0], [x1, z1], [x0, z1]]; }

function decagon(cx, cz, R) {
  const fp = [];
  for (let k = 0; k < 10; k++) {
    const th = (-108 + 36 * k) * Math.PI / 180;
    fp.push([cx + R * Math.cos(th), cz + R * Math.sin(th)]);
  }
  return fp;
}

const ROT_C = [0, 13.88], ROT_R = 4.5;
// pillar hall extents / pillar extents
const HX0 = 6.3, HX1 = 16.3, HZ0 = -5, HZ1 = 5;
const PX0 = 10.5, PX1 = 12.1, PZ0 = -0.8, PZ1 = 0.8;

const CELL_DEFS = [
  { name: 'gallery', fp: rect(-6, -4, 6, 4), h: 3.6,
    floor: { key: 'wood', roughFactor: 0.4 } },
  { name: 'corridor', fp: rect(-1.2, 4.3, 1.2, 9.3), h: 3.0,
    floor: { key: 'concrete', roughFactor: 1.3 } },
  { name: 'rotunda', fp: decagon(ROT_C[0], ROT_C[1], ROT_R), h: 5.0,
    floor: { key: 'marble', roughFactor: 0.25, specBoost: 4.5 } },
  { name: 'hallN', fp: [[HX0, HZ1], [HX1, HZ1], [PX1, PZ1], [PX0, PZ1]], h: 3.6,
    edges: [{}, { open: true }, { mat: 'concrete' }, { open: true }],
    floor: { key: 'concrete', roughFactor: 0.35 } },
  { name: 'hallE', fp: [[HX1, HZ1], [HX1, HZ0], [PX1, PZ0], [PX1, PZ1]], h: 3.6,
    edges: [{}, { open: true }, { mat: 'concrete' }, { open: true }],
    floor: { key: 'concrete', roughFactor: 0.35 } },
  { name: 'hallS', fp: [[HX1, HZ0], [HX0, HZ0], [PX0, PZ0], [PX1, PZ0]], h: 3.6,
    edges: [{}, { open: true }, { mat: 'concrete' }, { open: true }],
    floor: { key: 'concrete', roughFactor: 0.35 } },
  { name: 'hallW', fp: [[HX0, HZ0], [HX0, HZ1], [PX0, PZ1], [PX0, PZ0]], h: 3.6,
    edges: [{}, { open: true }, { mat: 'concrete' }, { open: true }],
    floor: { key: 'concrete', roughFactor: 0.35 } },
  { name: 'L1', fp: [[6.3, -11.6], [12.3, -11.6], [16.3, -11.6], [16.3, -5.3], [6.3, -5.3]], h: 3.6,
    edges: [{}, { open: true }, {}, {}, {}],
    floor: { key: 'wood', roughFactor: 0.55 } },
  { name: 'L2', fp: [[12.3, -17.6], [16.3, -17.6], [16.3, -11.6], [12.3, -11.6]], h: 3.6,
    edges: [{}, {}, { open: true }, {}],
    floor: { key: 'wood', roughFactor: 0.55 } },
  // lights-off room: one small saturated lamp in a corner -- stress test for
  // diffuse props and irradiance quality in a strongly colored environment
  { name: 'darkroom', fp: rect(12.3, -23.9, 17.3, -17.9), h: 3.2,
    floor: { key: 'concrete', roughFactor: 1.5 } },
  // exhibit wing north of the rotunda: two halls for the PBR models, plus a
  // Cornell box cell (red/green side walls, single ceiling area light) as the
  // canonical end-to-end GI/PBR validator
  { name: 'hallA', fp: rect(-3.5, 18.46, 3.5, 26.46), h: 4.0,
    floor: { key: 'wood', roughFactor: 0.55 } },
  { name: 'cornell', fp: rect(3.8, 19.9, 9.0, 25.1), h: 5.2,
    edges: [{ mat: 'cornellGreen' }, { mat: 'cornellWhite' }, { mat: 'cornellRed' }, { mat: 'cornellWhite' }],
    floor: { key: 'cornellWhite', roughFactor: 1 } },
  { name: 'hallB', fp: rect(-10.5, 19.9, -3.8, 25.1), h: 4.0,
    floor: { key: 'marble', roughFactor: 0.7 } },
];

// doorways: c = point between the two parallel walls; w/h = opening size
const DOOR_DEFS = [
  { a: 0, b: 1, c: [0, 4.15], w: 1.6, h: 2.4 },
  { a: 1, b: 2, c: [0, 9.45], w: 1.4, h: 2.4 },
  { a: 0, b: 6, c: [6.15, 0], w: 1.8, h: 2.6 },
  { a: 5, b: 7, c: [11.3, -5.15], w: 1.6, h: 2.4 },
  { a: 8, b: 9, c: [14.3, -17.75], w: 1.4, h: 2.2 },
  { a: 2, b: 10, c: [0, 18.31], w: 1.4, h: 2.4 },
  { a: 10, b: 11, c: [3.65, 22.5], w: 1.3, h: 2.2 },
  { a: 10, b: 12, c: [-3.65, 22.5], w: 1.4, h: 2.4 },
];

// analytic point lights per cell (no shadow maps; per-cell light lists keep light
// from leaking through walls). Colocated emissive ceiling panels appear in bakes
// so reflections show believable fixtures.
const WARM = [1.0, 0.87, 0.72], NEUT = [1.0, 0.96, 0.9], COOL = [0.85, 0.92, 1.0];
const LIGHT_DEFS = [
  [{ p: [-2.8, 3.25, 0], c: WARM, i: 9 }, { p: [2.8, 3.25, 0], c: WARM, i: 9 }],
  [{ p: [0, 2.7, 6.8], c: NEUT, i: 4 }],
  [{ p: [0, 4.0, 13.88], c: COOL, i: 16 }],
  [{ p: [8.8, 3.2, 0], c: NEUT, i: 8 }, { p: [13.8, 3.2, 0], c: NEUT, i: 8 }],
  [{ p: [8.8, 3.2, 0], c: NEUT, i: 8 }, { p: [13.8, 3.2, 0], c: NEUT, i: 8 }],
  [{ p: [8.8, 3.2, 0], c: NEUT, i: 8 }, { p: [13.8, 3.2, 0], c: NEUT, i: 8 }],
  [{ p: [8.8, 3.2, 0], c: NEUT, i: 8 }, { p: [13.8, 3.2, 0], c: NEUT, i: 8 }],
  // L1/L2 share an open portal, so they share the union of their lights --
  // per-cell direct lighting must be continuous across virtual portals.
  [{ p: [8.5, 3.2, -8.5], c: WARM, i: 7 }, { p: [13.5, 3.2, -8.5], c: WARM, i: 7 }, { p: [14.3, 3.2, -14.5], c: WARM, i: 7 }],
  [{ p: [8.5, 3.2, -8.5], c: WARM, i: 7 }, { p: [13.5, 3.2, -8.5], c: WARM, i: 7 }, { p: [14.3, 3.2, -14.5], c: WARM, i: 7 }],
  // darkroom: only the corner lamp
  [{ p: [16.6, 0.6, -23.2], c: [1.0, 0.22, 0.05], i: 6 }],
  [{ p: [0, 3.6, 20.6], c: NEUT, i: 8 }, { p: [0, 3.6, 24.3], c: NEUT, i: 8 }],
  [], // cornell: lit purely by its ceiling area light (the point of the test)
  [{ p: [-7.15, 3.6, 20.9], c: NEUT, i: 8 }, { p: [-7.15, 3.6, 24.1], c: NEUT, i: 8 }],
];

const PANEL_DEFS = [
  { cell: 0, x: -2.8, z: 0, sx: 1.8, sz: 1.0, i: 5 },
  { cell: 0, x: 2.8, z: 0, sx: 1.8, sz: 1.0, i: 5 },
  { cell: 1, x: 0, z: 6.8, sx: 0.8, sz: 2.4, i: 4 },
  { cell: 2, x: 0, z: 13.88, sx: 2.6, sz: 2.6, i: 5 },
  { cell: 3, x: 11.3, z: 2.9, sx: 1.5, sz: 1.0, i: 4 },
  { cell: 5, x: 11.3, z: -2.9, sx: 1.5, sz: 1.0, i: 4 },
  { cell: 6, x: 8.8, z: 0, sx: 1.0, sz: 1.5, i: 4 },
  { cell: 4, x: 13.8, z: 0, sx: 1.0, sz: 1.5, i: 4 },
  { cell: 7, x: 8.5, z: -8.5, sx: 1.5, sz: 1.0, i: 5 },
  { cell: 7, x: 13.5, z: -8.5, sx: 1.5, sz: 1.0, i: 5 },
  { cell: 8, x: 14.3, z: -14.5, sx: 1.5, sz: 1.0, i: 5 },
  // darkroom floor lamp: small, low, strongly colored (drives all GI in there)
  { cell: 9, x: 16.6, z: -23.2, sx: 0.3, sz: 0.3, y: 0.55, i: 9, color: [1.0, 0.22, 0.05] },
  { cell: 10, x: 0, z: 20.6, sx: 1.6, sz: 1.2, i: 5 },
  { cell: 10, x: 0, z: 24.3, sx: 1.6, sz: 1.2, i: 5 },
  { cell: 11, x: 6.4, z: 22.5, sx: 1.4, sz: 1.4, i: 110 }, // cornell area light
  { cell: 12, x: -7.15, z: 20.9, sx: 1.6, sz: 1.2, i: 5 },
  { cell: 12, x: -7.15, z: 24.1, sx: 1.6, sz: 1.2, i: 5 },
];

// paintings: index into PAINTINGS, wall-mounted (pos on wall surface, normal into room)
const PAINTING_DEFS = [
  { cell: 0, tex: 0, pos: [-3.2, 1.62, 4], n: [0, -1] },
  { cell: 0, tex: 2, pos: [3.2, 1.62, 4], n: [0, -1] },
  { cell: 0, tex: 7, pos: [-2.8, 1.62, -4], n: [0, 1] },
  { cell: 0, tex: 5, pos: [2.8, 1.62, -4], n: [0, 1] },
  { cell: 0, tex: 3, pos: [-6, 1.62, 0], n: [1, 0] },
  { cell: 1, tex: 1, pos: [1.2, 1.55, 6.8], n: [-1, 0], scale: 0.7 },
  { cell: 3, tex: 7, pos: [12.5, 1.7, 5], n: [0, -1] },
  { cell: 4, tex: 3, pos: [16.3, 1.62, 1.5], n: [-1, 0] },
  { cell: 5, tex: 1, pos: [8.5, 1.62, -5], n: [0, 1] },
  { cell: 6, tex: 0, pos: [10.5, 1.55, 0], n: [-1, 0], scale: 0.6 },
  { cell: 7, tex: 4, pos: [8, 1.62, -5.3], n: [0, -1] },
  { cell: 7, tex: 5, pos: [6.3, 1.62, -8.5], n: [1, 0] },
  { cell: 7, tex: 2, pos: [16.3, 1.62, -8.5], n: [-1, 0] },
  { cell: 8, tex: 0, pos: [12.95, 1.62, -17.6], n: [0, 1], scale: 0.8 },
  { cell: 8, tex: 6, pos: [16.3, 1.62, -14.5], n: [-1, 0] },
  { cell: 9, tex: 3, pos: [12.3, 1.62, -21], n: [1, 0] },
];

const BENCH_DEFS = [
  { cell: 0, x: 0, z: -2.8, rot: 0 },
  { cell: 3, x: 11.3, z: 3.2, rot: 0 },
  { cell: 6, x: 8.2, z: 0, rot: Math.PI / 2 },
  { cell: 7, x: 11, z: -8.5, rot: 0 },
  { cell: 9, x: 14.8, z: -21.5, rot: 0 },
];

const PEDESTAL_DEFS = [
  { cell: 0, x: -2.5, z: 1.4 }, { cell: 0, x: 0, z: 1.4 }, { cell: 0, x: 2.5, z: 1.4 },
  { cell: 0, x: -2.5, z: -1.4 }, { cell: 0, x: 0, z: -1.4 }, { cell: 0, x: 2.5, z: -1.4 },
  { cell: 10, x: -1.8, z: 21 }, { cell: 10, x: 1.8, z: 21 },
  { cell: 10, x: -1.8, z: 24 }, { cell: 10, x: 1.8, z: 24 },
  { cell: 12, x: -8.5, z: 22.5 }, { cell: 12, x: -5.8, z: 21 }, { cell: 12, x: -5.8, z: 24 },
];

// rotunda paintings get placed on decagon edges by index
const ROTUNDA_PAINTINGS = [{ edge: 3, tex: 4 }, { edge: 6, tex: 6 }];

// ---------------------------------------------------------------- construction

const EPS = 1e-4;

function centroid2(fp) {
  let x = 0, z = 0;
  for (const p of fp) { x += p[0]; z += p[1]; }
  return [x / fp.length, z / fp.length];
}

export function buildLevel() {
  const cells = CELL_DEFS.map((def, id) => {
    const fp = def.fp;
    const c2 = centroid2(fp);
    const floorY = 0, ceilY = def.h;
    const planes = [];
    const addPlane = (n, d) => {
      for (let i = 0; i < planes.length; i++) {
        const q = planes[i];
        if (q.n.dot(n) > 0.9999 && Math.abs(q.d - d) < 1e-3) return i;
      }
      planes.push({ n: n.clone(), d });
      return planes.length - 1;
    };
    addPlane(new THREE.Vector3(0, 1, 0), -floorY);
    addPlane(new THREE.Vector3(0, -1, 0), ceilY);
    const edges = fp.map((a, i) => {
      const b = fp[(i + 1) % fp.length];
      const meta = (def.edges && def.edges[i]) || {};
      // wall normal: perpendicular to edge, pointing toward the centroid
      let nx = -(b[1] - a[1]), nz = b[0] - a[0];
      const len = Math.hypot(nx, nz); nx /= len; nz /= len;
      const toC = (c2[0] - a[0]) * nx + (c2[1] - a[1]) * nz;
      if (toC < 0) { nx = -nx; nz = -nz; }
      const n = new THREE.Vector3(nx, 0, nz);
      const planeIndex = addPlane(n, -(nx * a[0] + nz * a[1]));
      return { a, b, n, planeIndex, open: !!meta.open, mat: meta.mat || 'plaster', holes: [] };
    });
    // irradiance probe grid: uniform in the hull bbox (probes near walls get
    // clamped inward at bake time; interpolation coords stay bbox-uniform)
    const xs = fp.map(p => p[0]), zs = fp.map(p => p[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minZ = Math.min(...zs), maxZ = Math.max(...zs);
    const dimFor = s => Math.max(2, Math.min(4, Math.round(s / 2.4) + 1));
    const probeGrid = {
      min: [minX, floorY, minZ],
      size: [maxX - minX, ceilY - floorY, maxZ - minZ],
      dims: [dimFor(maxX - minX), 2, dimFor(maxZ - minZ)], // <= 4*2*4 = 32 probes
    };
    return {
      id, name: def.name, fp, floorY, ceilY, planes, edges,
      floor: def.floor,
      capture: new THREE.Vector3(c2[0], floorY + Math.min(2.1, (ceilY - floorY) * 0.55), c2[1]),
      lights: (LIGHT_DEFS[id] || []).map(l => ({ pos: l.p.slice(), color: l.c.slice(), intensity: l.i })),
      portals: [],
      builders: new Map(),
      probeGrid,
    };
  });

  // builders carry their material opts (mapKey / paintingIndex / tint / emissive
  // / floor gloss) so mesh creation AND the lightmapper share one source
  const getBuilder = (cell, key, opts = {}) => {
    if (!cell.builders.has(key)) cell.builders.set(key, { geo: new GeoBuilder(), opts });
    return cell.builders.get(key).geo;
  };

  // portal rect on a cell edge: s0..s1 along edge (from edge.a), y0..y1.
  // planeShift moves the rect outward along -edge.n (door portals live on the
  // shared wall mid-plane, so mutual door portals coincide exactly).
  function makePortal(cell, edge, neighbor, s0, s1, y0, y1, isVirtual, planeShift = 0) {
    const u = new THREE.Vector3(edge.b[0] - edge.a[0], 0, edge.b[1] - edge.a[1]).normalize();
    const off = edge.n.clone().multiplyScalar(-planeShift);
    const P = (s, y) => new THREE.Vector3(edge.a[0] + u.x * s + off.x, y, edge.a[1] + u.z * s + off.z);
    const corners = [P(s0, y0), P(s1, y0), P(s1, y1), P(s0, y1)];
    const up = new THREE.Vector3(0, 1, 0);
    const edgePlanes = [
      { n: u.clone(), d: -u.dot(corners[0]) },                    // left
      { n: u.clone().negate(), d: u.dot(corners[1]) },            // right
      { n: up.clone(), d: -y0 },                                  // bottom
      { n: up.clone().negate(), d: y1 },                          // top
    ];
    // Classify each edge for specular blending. SILHOUETTE edge: real geometry
    // beyond it breaks the portal plane (pillar corner, doorframe) -- blend for
    // cone-footprint AA of the partition. CONTINUATION edge: the neighbor has a
    // coplanar plane continuing the local surface across the edge (floor under
    // a cut, the L-rooms' shared east wall) -- never blend; recursion is already
    // seamless and blending would ghost far-behind-plane content.
    const cornerPairs = [[0, 3], [1, 2], [0, 1], [2, 3]]; // matches edgePlanes order
    let blendMask = 0;
    cornerPairs.forEach((pr, e) => {
      let silhouette = true;
      for (let pi = 0; pi < cell.planes.length; pi++) {
        if (pi === edge.planeIndex) continue;
        const pl = cell.planes[pi];
        if (Math.abs(pl.n.dot(corners[pr[0]]) + pl.d) > 6e-3) continue;
        if (Math.abs(pl.n.dot(corners[pr[1]]) + pl.d) > 6e-3) continue;
        for (const q of cells[neighbor].planes) {
          if (q.n.dot(pl.n) > 0.999 && Math.abs(q.d - pl.d) < 6e-3) { silhouette = false; break; }
        }
        break;
      }
      if (silhouette) blendMask |= 1 << e;
    });
    const portal = { planeIndex: edge.planeIndex, neighbor, corners, edgePlanes, virtual: !!isVirtual, blendMask };
    cell.portals.push(portal);
    return portal;
  }

  function findEdgeNear(cell, pt, maxDist = 0.26) {
    let best = null, bestD = maxDist;
    for (const e of cell.edges) {
      const ax = e.a[0], az = e.a[1], bx = e.b[0], bz = e.b[1];
      const dx = bx - ax, dz = bz - az;
      const L2 = dx * dx + dz * dz;
      let t = ((pt[0] - ax) * dx + (pt[1] - az) * dz) / L2;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(pt[0] - (ax + dx * t), pt[1] - (az + dz * t));
      if (d < bestD) { bestD = d; best = { edge: e, t, s: t * Math.sqrt(L2) }; }
    }
    return best;
  }

  // ---- doorways: holes, portals both sides, jamb geometry.
  // Doored hull planes are pulled to the shared wall MID-plane so both sides'
  // portals are the same rectangle on the same plane and the two hulls tile
  // space with no dead gap in the doorway (cell flips happen exactly at the
  // shared plane -- no hull-clamp jumps for objects mid-crossing). The visible
  // wall meshes stay at the room surface; those walls' reflections pick up a
  // WALL_T/2 parallax error, which is classic-PCCM scale and acceptable.
  const doors = DOOR_DEFS.map(def => {
    const sides = [[def.a, def.b], [def.b, def.a]].map(([selfId, otherId]) => {
      const cell = cells[selfId];
      const hit = findEdgeNear(cell, def.c);
      if (!hit) throw new Error(`door lookup failed for cell ${cell.name} near ${def.c}`);
      const { edge, s } = hit;
      const s0 = s - def.w / 2, s1 = s + def.w / 2;
      edge.holes.push({ s0, s1, yTop: cell.floorY + def.h });
      if (!edge.doorShifted) {
        cell.planes[edge.planeIndex].d += WALL_T / 2;
        edge.doorShifted = true;
      }
      const portal = makePortal(cell, edge, otherId, s0, s1, cell.floorY, cell.floorY + def.h, false, WALL_T / 2);
      // rim rect at the visible wall surface (unshifted) -- used for jamb geometry
      const u = new THREE.Vector3(edge.b[0] - edge.a[0], 0, edge.b[1] - edge.a[1]).normalize();
      const R = (ss, y) => new THREE.Vector3(edge.a[0] + u.x * ss, y, edge.a[1] + u.z * ss);
      const rim = [R(s0, cell.floorY), R(s1, cell.floorY), R(s1, cell.floorY + def.h), R(s0, cell.floorY + def.h)];
      return { cell, edge, portal, rim };
    });
    return { def, sides };
  });

  // ---- open (virtual) portals: pair up open edges with identical reversed endpoints
  const near = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-3;
  for (const cell of cells) {
    for (const edge of cell.edges) {
      if (!edge.open || edge.paired) continue;
      let found = false;
      for (const other of cells) {
        if (other === cell) continue;
        for (const oe of other.edges) {
          if (!oe.open || oe.paired) continue;
          if (near(edge.a, oe.b) && near(edge.b, oe.a)) {
            edge.paired = oe.paired = true;
            const len = Math.hypot(edge.b[0] - edge.a[0], edge.b[1] - edge.a[1]);
            const y1 = Math.min(cell.ceilY, other.ceilY);
            makePortal(cell, edge, other.id, 0, len, cell.floorY, y1, true);
            const olen = Math.hypot(oe.b[0] - oe.a[0], oe.b[1] - oe.a[1]);
            makePortal(other, oe, cell.id, 0, olen, other.floorY, y1, true);
            found = true;
            break;
          }
        }
        if (found) break;
      }
      if (!found) throw new Error(`unpaired open edge in ${cell.name}`);
    }
  }

  // ---- meshes: floors, ceilings, walls (with holes)
  for (const cell of cells) {
    const fb = getBuilder(cell, 'floor',
      { mapKey: cell.floor.key, roughFactor: cell.floor.roughFactor,
        specBoost: cell.floor.specBoost });
    const cb = getBuilder(cell, 'plasterPlain', { mapKey: 'plasterPlain' });
    const uvf = p => [p[0] * 0.35, p[2] * 0.35];
    const floorPts = cell.fp.map(p => [p[0], cell.floorY, p[1]]);
    fb.polygon(floorPts, [0, 1, 0], uvf); // one chart per floor: no lightmap seams inside
    cb.polygon(floorPts.map(p => [p[0], cell.ceilY, p[2]]), [0, -1, 0], uvf);
    for (const edge of cell.edges) {
      if (edge.open) continue;
      // concrete walls use the wall-styled set (form-tie panels); the plain
      // 'concrete' key stays on floors where panel seams would look wrong
      const wb = getBuilder(cell, edge.mat, {
        mapKey: edge.mat === 'concrete' ? 'concreteWall' : edge.mat });
      const len = Math.hypot(edge.b[0] - edge.a[0], edge.b[1] - edge.a[1]);
      const h = cell.ceilY - cell.floorY;
      const u = [(edge.b[0] - edge.a[0]) / len, (edge.b[1] - edge.a[1]) / len];
      const n3 = [edge.n.x, 0, edge.n.z];
      const emitWall = (sa, sb, ya, yb) => {
        if (sb - sa < 1e-4 || yb - ya < 1e-4) return;
        const P = (s, y) => [edge.a[0] + u[0] * s, y, edge.a[1] + u[1] * s];
        // plaster v spans the full wall height once (baseboard stays at the floor)
        const vv = edge.mat === 'plaster' ? y => (y - cell.floorY) / h * 0.999 : y => y * 0.4;
        const uu = s => s * (edge.mat === 'plaster' ? 0.25 : 0.4);
        wb.quad([P(sa, ya), P(sb, ya), P(sb, yb), P(sa, yb)], n3,
          [[uu(sa), vv(ya)], [uu(sb), vv(ya)], [uu(sb), vv(yb)], [uu(sa), vv(yb)]]);
      };
      if (edge.holes.length === 0) {
        emitWall(0, len, cell.floorY, cell.ceilY);
      } else {
        const hole = edge.holes[0]; // one doorway per wall in this level
        emitWall(0, hole.s0, cell.floorY, cell.ceilY);
        emitWall(hole.s1, len, cell.floorY, cell.ceilY);
        emitWall(hole.s0, hole.s1, hole.yTop, cell.ceilY);
      }
    }
  }

  // ---- door jambs (assigned to side-a cell), spanning the wall-surface rims
  for (const door of doors) {
    const [sa, sb] = door.sides;
    const A = sa.rim, B = sb.rim;
    // pair each corner of A with the nearest corner of B
    const Bp = A.map(a => {
      let best = B[0], bd = Infinity;
      for (const b of B) { const d = a.distanceToSquared(b); if (d < bd) { bd = d; best = b; } }
      return best;
    });
    // plasterPlain: the plaster set's baked-in baseboard stripe (v < 0.045)
    // must not paint across jamb reveals (the "footers in door frames" bug)
    const jb = getBuilder(sa.cell, 'plasterPlain', { mapKey: 'plasterPlain' });
    const fb = getBuilder(sa.cell, 'floor');
    const mid = A[0].clone().add(A[2]).add(Bp[0]).add(Bp[2]).multiplyScalar(0.25);
    const quadToward = (builder, p0, p1, p2, p3) => {
      const e1 = p1.clone().sub(p0), e2 = p3.clone().sub(p0);
      // world-proportional UVs at the floor/ceiling density; a fixed square
      // scale squashed the texture ~10:1 on the tall thin reveals
      const us = e1.length() * 0.35, vs = e2.length() * 0.35;
      const g = e1.clone().cross(e2);
      const inC = mid.clone().sub(p0);
      const n = g.dot(inC) >= 0 ? g.normalize() : g.negate().normalize();
      builder.quad([p0.toArray(), p1.toArray(), p2.toArray(), p3.toArray()], n.toArray(),
        [[0, 0], [us, 0], [us, vs], [0, vs]]);
    };
    quadToward(jb, A[0], Bp[0], Bp[3], A[3]);   // left reveal
    quadToward(jb, A[1], Bp[1], Bp[2], A[2]);   // right reveal
    quadToward(jb, A[3], Bp[3], Bp[2], A[2]);   // lintel underside
    quadToward(fb, A[0], Bp[0], Bp[1], A[1]);   // floor strip
  }

  // ---- paintings (rotunda ones resolved to decagon edges), built as geometry:
  // framed canvas quads through the chart-aware builder path so they get
  // lightmap UVs and participate in the path-traced bake like everything else
  const paintings = PAINTING_DEFS.slice();
  for (const rp of ROTUNDA_PAINTINGS) {
    const cell = cells[2];
    const e = cell.edges[rp.edge];
    const mx = (e.a[0] + e.b[0]) / 2, mz = (e.a[1] + e.b[1]) / 2;
    paintings.push({ cell: 2, tex: rp.tex, pos: [mx, 1.75, mz], n: [e.n.x, e.n.z] });
  }
  paintings.forEach((p, i) => {
    const cell = cells[p.cell];
    const def = PAINTINGS[p.tex];
    const scale = p.scale || 1;
    const h = def.h * scale, w = def.h * def.aspect * scale;
    const n = V.norm([p.n[0], 0, p.n[1]]);
    const up = [0, 1, 0];
    const right = V.norm(V.cross(up, n));
    getBuilder(cell, 'walnut', { mapKey: 'walnut' })
      .orientedBox(V.mad(p.pos, n, 0.03), right, up, n, [w + 0.14, h + 0.14, 0.06], 0.8);
    const c = V.mad(p.pos, n, 0.062);
    getBuilder(cell, `painting${i}`, { paintingIndex: p.tex }).quad([
      V.mad(V.mad(c, right, -w / 2), up, -h / 2),
      V.mad(V.mad(c, right, w / 2), up, -h / 2),
      V.mad(V.mad(c, right, w / 2), up, h / 2),
      V.mad(V.mad(c, right, -w / 2), up, h / 2),
    ], n, [[0, 0], [1, 0], [1, 1], [0, 1]]);
  });

  // ---- benches, pedestals (+ player colliders)
  const colliders = [];
  for (const b of BENCH_DEFS) {
    // 'furniture' is a separate builder from 'walnut' (frames): furniture has
    // capsule proxies, so it is excluded from the bakes (occProxied) - one
    // representation per object - while frames keep casting normally
    const wb = getBuilder(cells[b.cell], 'furniture', { mapKey: 'walnut', occProxied: true });
    const cos = Math.cos(b.rot), sin = Math.sin(b.rot);
    const put = (lx, ly, lz, sx, sy, sz) => {
      // rotate local xz by rot around bench center (axis-aligned boxes only at 0/90deg)
      const wx = b.x + lx * cos - lz * sin, wz = b.z + lx * sin + lz * cos;
      const rsx = Math.abs(sx * cos) + Math.abs(sz * sin), rsz = Math.abs(sx * sin) + Math.abs(sz * cos);
      wb.box(wx, ly, wz, rsx, sy, rsz, 0.8);
    };
    put(0, 0.47, 0, 1.5, 0.09, 0.42);
    put(-0.6, 0.21, 0, 0.08, 0.42, 0.38);
    put(0.6, 0.21, 0, 0.08, 0.42, 0.38);
    // rx/rz/rot/h: footprint + height for the analytic occluder capsules
    // (seat is 1.5x0.42, legs at +-0.6); r stays the player-collision radius
    colliders.push({ x: b.x, z: b.z, r: 0.85, rx: 0.7, rz: 0.24, rot: b.rot, h: 0.56 });
  }
  for (const p of PEDESTAL_DEFS) {
    getBuilder(cells[p.cell], 'furniture', { mapKey: 'walnut', occProxied: true })
      .box(p.x, 0.5, p.z, 0.42, 1.0, 0.42, 0.8);
    colliders.push({ x: p.x, z: p.z, r: 0.4, rx: 0.24, rz: 0.24, rot: 0, h: 1.0 });
  }

  // panels: emissive fixture geometry (the light sources seen in reflections,
  // and the area lights of the path-traced lightmap bake)
  const panels = PANEL_DEFS.map((p, idx) => {
    const cell = cells[p.cell];
    const y = p.y !== undefined ? p.y : cell.ceilY - 0.06;
    const c = p.color || [1, 0.96, 0.88];
    const e = p.i;
    getBuilder(cell, `panel${idx}`, {
      mapKey: 'white', tint: [0.03, 0.03, 0.03],
      emissive: [e * c[0], e * c[1], e * c[2]],
    }).box(p.x, y, p.z, p.sx, 0.08, p.sz, 1);
    return { cell: p.cell, x: p.x, y, z: p.z, sx: p.sx, sz: p.sz, intensity: p.i, color: c };
  });

  return {
    cells, paintings, panels, colliders, doors,
    spawn: { pos: new THREE.Vector3(-4, 0, 2), yaw: -Math.PI / 2 },
  };
}

// ---------------------------------------------------------------- point queries

export function minPlaneDist(cell, p) {
  let m = Infinity;
  for (const pl of cell.planes) m = Math.min(m, pl.n.dot(p) + pl.d);
  return m;
}

export function findCell(cells, p, hint = -1) {
  if (hint >= 0) {
    const cands = [hint, ...cells[hint].portals.map(q => q.neighbor)];
    let best = hint, bd = -Infinity;
    for (const c of cands) {
      const d = minPlaneDist(cells[c], p);
      if (d > bd) { bd = d; best = c; }
    }
    if (bd > -0.5) return best;
  }
  let best = 0, bd = -Infinity;
  for (const c of cells) {
    const d = minPlaneDist(c, p);
    if (d > bd) { bd = d; best = c.id; }
  }
  return best;
}

export function clampToHull(cell, p, margin = 0.02) {
  for (let it = 0; it < 3; it++) {
    let moved = false;
    for (const pl of cell.planes) {
      const d = pl.n.dot(p) + pl.d;
      if (d < margin) { p.addScaledVector(pl.n, margin - d); moved = true; }
    }
    if (!moved) break;
  }
  return p;
}
