// Pointer-lock FPS controller. Collision reuses the hull structure: solid cell
// planes push the capsule out; planes with a portal are passable only where the
// crossing point lies inside the portal polygon. Cell membership is tracked by
// most-inside among {current cell + portal neighbors}.
import * as THREE from 'three';
import { findCell, pushOutCollider, WALL_T } from './level.js';

const EYE = 1.7;
const RADIUS = 0.32;

export class Player {
  constructor(level, dom, opts = {}) {
    this.level = level;
    this.pos = level.spawn.pos.clone().setY(EYE);
    this.yaw = level.spawn.yaw;
    this.pitch = 0;
    this.vel = new THREE.Vector3();
    this.cell = findCell(level.cells, this.pos);
    this.noclip = false;
    this.keys = new Set();
    this.moveAxis = null; // analog input {x: strafe, y: forward} in -1..1 (touch joystick)
    this.locked = false;
    this.lookLocked = false; // hold-E prop rotation owns the mouse while set
    this.interactive = !opts.headless;
    if (this.interactive) this.bind(dom);
  }

  bind(dom) {
    dom.addEventListener('click', () => {
      if (!this.locked) dom.requestPointerLock();
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === dom;
      document.getElementById('crosshair').classList.toggle('hidden', !this.locked);
      document.getElementById('help').classList.toggle('hidden', !this.locked);
    });
    document.addEventListener('mousemove', e => {
      if (!this.locked || this.lookLocked) return;
      this.yaw -= e.movementX * 0.0022;
      this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch - e.movementY * 0.0022));
    });
    document.addEventListener('keydown', e => {
      this.keys.add(e.code);
      if (e.code === 'KeyV') this.noclip = !this.noclip;
    });
    document.addEventListener('keyup', e => this.keys.delete(e.code));
  }

  get viewDir() {
    const cp = Math.cos(this.pitch);
    return new THREE.Vector3(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
  }

  applyToCamera(cam) {
    cam.position.copy(this.pos);
    cam.rotation.set(0, 0, 0);
    cam.rotateY(this.yaw);
    cam.rotateX(this.pitch);
  }

  update(dt, colliders) {
    const k = this.keys;
    const speed = (k.has('ShiftLeft') || k.has('ShiftRight')) ? 5.5 : 3.2;
    const fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const wish = new THREE.Vector3();
    if (k.has('KeyW')) wish.add(fwd);
    if (k.has('KeyS')) wish.sub(fwd);
    if (k.has('KeyD')) wish.add(right);
    if (k.has('KeyA')) wish.sub(right);
    if (wish.lengthSq() > 0) wish.normalize().multiplyScalar(speed);
    if (this.moveAxis && (this.moveAxis.x !== 0 || this.moveAxis.y !== 0)) {
      wish.addScaledVector(fwd, this.moveAxis.y * speed);
      wish.addScaledVector(right, this.moveAxis.x * speed);
    }
    if (this.noclip) {
      wish.y = (k.has('Space') ? speed : 0) - (k.has('ControlLeft') ? speed : 0);
      if (k.has('KeyW') || k.has('KeyS')) {
        const scale = k.has('KeyW') ? 1 : -1;
        wish.y += Math.sin(this.pitch) * speed * scale;
      }
    }
    const smoothing = Math.min(1, dt * 12);
    this.vel.lerp(wish, smoothing);
    this.pos.addScaledVector(this.vel, dt);

    if (!this.noclip) {
      this.pos.y = EYE;
      this.collide(colliders);
    }
    this.cell = findCell(this.level.cells, this.pos, this.cell);
  }

  collide(colliders) {
    const cell = this.level.cells[this.cell];
    this.resolveWalls(cell);
    // Ring/junction corners are convex corners whose two walls belong to ADJACENT
    // cells that tile space across an OPEN SEAM (virtual portal): the current cell
    // owns only one of those walls. An open seam is not a wall, so the current
    // cell alone can't pin the capsule in the corner -- findCell then flip-flops
    // between the two cells every frame (violent jitter). Also resolve against
    // each open-seam neighbour's walls so both walls constrain the corner and the
    // settled point is the same whichever cell is current. Only OPEN SEAMS tile
    // with no wall between; door neighbours sit across a WALL_T gap, so their far
    // walls (e.g. the courtyard back wall) must NOT reach in here.
    for (const po of cell.portals) {
      if (!po.virtual) continue; // doorway neighbours don't continue our walls
      this.resolveWalls(this.level.cells[po.neighbor]);
    }
    for (const c of colliders) pushOutCollider(this.pos, c, RADIUS * 0.6);
  }

  // Push the capsule out of a cell's wall EDGES. Each wall is gated by its FINITE
  // segment (is the capsule within RADIUS of the actual edge span?) but the push
  // is along the edge's PLANE normal. Two-part design, both parts load-bearing:
  //  - Segment GATE: a borrowed neighbour wall is only real along its edge, so an
  //    infinite plane must not act past the span -- else the pillar face walls off
  //    the open floor north of the pillar, or the L2 wall flings the capsule
  //    across the L-bend. Gating by segment distance drops those phantoms and can
  //    never teleport (the capsule must already be within RADIUS of the segment).
  //  - Plane-normal PUSH: doored walls collide on a plane pulled to the shared
  //    WALL_T mid-plane, so the two cells' door planes coincide and the cell flip
  //    mid-doorway causes no jump. Inside that gap the capsule is outside both
  //    VISIBLE edges, so a radial push off the edge would shove it back out the
  //    doorway; the signed plane normal always pushes to the room side.
  // Open seams are not walls (skipped); a wall is passable wherever the capsule is
  // inside a portal opening on its plane -- a doorway hole, or the seam gap on a
  // plane a solid wall shares with an open seam (the L1 bottom wall at the L-bend).
  resolveWalls(cell) {
    for (const e of cell.edges) {
      if (e.open) continue; // open seam: the two cells tile here, not a wall
      const pl = cell.planes[e.planeIndex];
      if (Math.abs(pl.n.y) > 0.5) continue; // floors/ceilings: fixed eye height
      for (const po of cell.portals) {
        if (po.planeIndex === e.planeIndex) this.resolvePortalJamb(po, pl);
      }
      let passable = false;
      for (const po of cell.portals)
        if (po.planeIndex === e.planeIndex && this.insideLateral(po, RADIUS * 0.8)) { passable = true; break; }
      if (passable) continue;
      // gate: closest point on segment [a,b]; skip if the capsule is beyond the
      // wall's real span (rounds concave corners, drops borrowed-plane phantoms)
      const ax = e.a[0], az = e.a[1], ex = e.b[0] - ax, ez = e.b[1] - az;
      const len2 = ex * ex + ez * ez;
      let t = ((this.pos.x - ax) * ex + (this.pos.z - az) * ez) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const gx = this.pos.x - (ax + t * ex), gz = this.pos.z - (az + t * ez);
      if (gx * gx + gz * gz >= RADIUS * RADIUS) continue; // not within the span
      const d = pl.n.dot(this.pos) + pl.d;
      if (d < RADIUS) this.pos.addScaledVector(pl.n, RADIUS - d);
    }
  }

  resolvePortalJamb(portal, wallPlane) {
    if (portal.virtual) return; // open seams have no door frame
    // Doorway walls are represented by a mid-plane, while the visible jamb
    // reveal spans WALL_T around it. Only apply the side planes while the
    // capsule overlaps that doorway slab; otherwise the portal's lateral planes
    // would become invisible walls running across the room. The side response is
    // directional: sliding from the wall into the portal edge should keep using
    // the wall-plane correction, not get pulled forward into the doorway.
    const d = wallPlane.n.dot(this.pos) + wallPlane.d;
    const wallPush = RADIUS - d;
    if (wallPush <= 0 || Math.abs(d) > RADIUS + WALL_T / 2) return;
    for (const ep of portal.edgePlanes) {
      if (Math.abs(ep.n.y) > 0.5) continue;
      const ed = ep.n.dot(this.pos) + ep.d;
      if (ed <= -RADIUS || ed >= RADIUS) continue;
      const movingIntoOpening = this.vel.dot(ep.n) > 0.01;
      if (movingIntoOpening) {
        continue;
      } else if (ed >= 0) {
        const inPush = RADIUS - ed;
        if (inPush < wallPush) this.pos.addScaledVector(ep.n, inPush);
      }
    }
  }

  insideLateral(portal, margin) {
    // lateral edge planes only (skip the horizontal bottom/top planes)
    for (const ep of portal.edgePlanes) {
      if (Math.abs(ep.n.y) > 0.5) continue;
      if (ep.n.dot(this.pos) + ep.d < margin) return false;
    }
    return true;
  }
}
