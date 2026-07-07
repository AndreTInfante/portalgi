// Pointer-lock FPS controller. Collision reuses the hull structure: solid cell
// planes push the capsule out; planes with a portal are passable only where the
// crossing point lies inside the portal polygon. Cell membership is tracked by
// most-inside among {current cell + portal neighbors}.
import * as THREE from 'three';
import { findCell, pushOutCollider } from './level.js';

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
    for (let idx = 0; idx < cell.planes.length; idx++) {
      const pl = cell.planes[idx];
      if (Math.abs(pl.n.y) > 0.5) continue; // floors/ceilings handled by fixed eye height
      const d = pl.n.dot(this.pos) + pl.d;
      if (d >= RADIUS) continue;
      let passable = false;
      for (const po of cell.portals) {
        // lateral edges decide passability at eye height; door tops (2.4m+)
        // clear the 1.7m eye and the bottom edge is the floor itself
        if (po.planeIndex === idx && this.insideLateral(po, RADIUS * 0.8)) { passable = true; break; }
      }
      if (!passable) this.pos.addScaledVector(pl.n, RADIUS - d);
    }
    for (const c of colliders) pushOutCollider(this.pos, c, RADIUS * 0.6);
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
