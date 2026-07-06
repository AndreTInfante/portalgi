// Carryable props (gravity-gun style) with hull-plane physics.
// Diffuse / chrome / glass spheres + cube versions. The glass material samples
// the environment along the negated reflection vector (the HL:Alyx bottle trick),
// which makes it a razor-sharp probe of environment-approximation quality.
import * as THREE from 'three';
import * as CANNON from '../libs/cannon-es.js';
import { findCell, WALL_T } from './level.js';

const REST = 0.35;
const tmpD = new THREE.Vector3();
const HOLD_DIST = 0.12;  // rigid-attach rest offset in front of the hand (VR)
const CARRY_DIST = 1.9;  // ray-carry distance in front of the eye (desktop)

const PROP_DEFS = [
  // mode 4 = dynamic PBR prop: probe-grid diffuse + traversal specular
  { shape: 'sphere', mode: 4, x: -2.5, z: 1.4, tint: [0.85, 0.83, 0.8], roughFactor: 0.8, metalFactor: 0 },
  { shape: 'sphere', mode: 4, x: 0, z: 1.4, tint: [0.95, 0.96, 0.97], roughFactor: 0.04, metalFactor: 1 }, // chrome
  { shape: 'sphere', mode: 2, x: 2.5, z: 1.4 },
  { shape: 'cube', mode: 4, x: -2.5, z: -1.4, tint: [0.85, 0.4, 0.3], roughFactor: 0.8, metalFactor: 0 },
  // (chrome + glass cubes cut 2026-07-04: read poorly, and fewer dyn props
  // keeps the blob budget balanced - their pedestals now hold the small
  // horse and elephant moved over from hall A)
  // debug pane: near-clear glass, billboards to the camera while held -
  // hold it over scene geometry to see the hull approximation error directly.
  { shape: 'pane', mode: 3, x: 0.45, z: -2.8, y: 0.965, debugPane: true },
];

export class Props {
  constructor(scene, level, matsys, modelProps = [], physics = null) {
    this.level = level;
    this.matsys = matsys;
    this.physics = physics;
    // one hold per hand: key 'desktop' | 'left' | 'right' -> { p, hold }
    // (hold = hand-space offsets + beam progress). VR carries a prop in
    // EACH hand; desktop only ever uses its one slot.
    this.holds = new Map();
    this.carriers = {}; // per-key carriers, refreshed by main each frame (VR)
    // cannon 'collide' events feed the impact audio (with the per-prop cooldown)
    this.impactCb = (p, speed) => {
      if (!this.onImpact) return;
      const t = performance.now();
      if (t - (p.impactT || 0) > 120) { p.impactT = t; this.onImpact(p.mesh.position, speed, p); }
    };
    this.list = PROP_DEFS.map(def => {
      const r = def.shape === 'sphere' ? 0.22 : def.shape === 'pane' ? 0.3 : 0.18;
      const geo = def.shape === 'sphere' ? new THREE.SphereGeometry(0.22, 48, 32)
        : def.shape === 'pane' ? new THREE.BoxGeometry(0.65, 0.9, 0.02)
        : new THREE.BoxGeometry(0.36, 0.36, 0.36);
      const mat = matsys.makeMaterial(0, {
        mode: def.mode,
        tint: def.tint || [1, 1, 1],
        rough: 0.04,
        roughFactor: def.roughFactor,
        metalFactor: def.metalFactor,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.layers.set(3); // excluded from cubemap captures (layers 1/2 = XR eyes)
      mesh.position.set(def.x, def.y !== undefined ? def.y : 1.0 + r, def.z);
      scene.add(mesh);
      const p = {
        mesh, mats: [mat], radius: r, rFloor: r,
        vel: new THREE.Vector3(),
        round: def.shape === 'sphere',
        boxHalf: def.shape === 'cube' ? [0.18, 0.18, 0.18]
          : def.shape === 'pane' ? [0.325, 0.45, 0.03] : null,
        cell: 0,
        debugPane: !!def.debugPane,
      };
      if (physics) p.body = physics.addProp(p, this.impactCb);
      return p;
    });
    // imported glTF exhibits - same physics, multiple materials per prop
    for (const mp of modelProps) {
      scene.add(mp.root);
      const p = {
        mesh: mp.root, mats: mp.mats, radius: mp.radius, rFloor: mp.rFloor,
        vel: new THREE.Vector3(),
        round: false, boxHalf: null,
        cell: mp.cell,
        debugPane: false,
        slug: mp.slug, // authored occluder proxy key (proxies.js)
      };
      if (physics) p.body = physics.addProp(p, this.impactCb);
      this.list.push(p);
    }
  }

  // legacy single-held view (desktop paths, crosshair checks): first hold
  get held() {
    for (const h of this.holds.values()) return h.p;
    return null;
  }

  holderKey(p) {
    for (const [k, h] of this.holds) if (h.p === p) return k;
    return null;
  }

  _carrierFor(key, fallback) {
    return key === 'desktop' ? fallback : (this.carriers[key] || fallback);
  }

  // carrier: { pos, quat (Quaternion|null), viewDir, vel, eye?, mode? }.
  // mode 'attach' = rigid follow via hand-space offsets (VR controllers);
  // anything else = the desktop ray-carry spring. The desktop Player instance
  // itself is a valid carrier (no quat/mode -> ray path). VR hands' carriers
  // arrive via this.carriers (per key), refreshed by main each frame.
  update(dt, carrier) {
    // kinematic bodies (held props) do not wake sleeping dynamics on
    // contact in cannon - after a while everything sleeps and the held prop
    // ghosts through it. Nudge sleepers awake as any held prop approaches.
    for (const h of this.holds.values()) {
      if (!h.p.body) continue;
      const hp = h.p.mesh.position;
      for (const q of this.list) {
        if (this.holderKey(q) || !q.body) continue;
        if (q.body.sleepState === CANNON.Body.SLEEPING) {
          const reach = h.p.radius + q.radius + 0.25;
          if (hp.distanceToSquared(q.mesh.position) < reach * reach) q.body.wakeUp();
        }
      }
    }
    if (this.physics) this.physics.step(dt);
    for (const p of this.list) {
      const key = this.holderKey(p);
      if (key) {
        this.updateHeld(p, dt, this._carrierFor(key, carrier), this.holds.get(key).hold);
        if (p.body) { // kinematic body follows the carried mesh and pushes others
          p.body.position.copy(p.mesh.position);
          p.body.quaternion.copy(p.mesh.quaternion);
          p.body.velocity.copy(p.vel);
        }
      } else if (p.body && p.body.sleepState !== CANNON.Body.SLEEPING) {
        // interpolated, NOT the raw stepped transform: physics is a fixed 90Hz
        // (FIXED_DT) but we render at 72, so the discrete body.position advances
        // in 1/90 chunks against 1/72 frames = uneven per-frame motion = judder
        // on fast throws. cannon lerp/slerps these from the leftover accumulator
        // time each step() for smooth rendering at any display rate.
        p.mesh.position.copy(p.body.interpolatedPosition);
        p.mesh.quaternion.copy(p.body.interpolatedQuaternion);
      }
      const pos = p.mesh.position;
      const prevCell = p.cell;
      p.cell = findCell(this.level.cells, pos, p.cell);
      if (p.cell !== prevCell) p.contacts = 0; // plane indices renumber per cell
      for (const m of p.mats) {
        this.matsys.setMaterialCell(m, p.cell); // arms a 0.2s diffuse crossfade on change
        const u = m.uniforms;
        if (u.uPrevMix.value > 0) u.uPrevMix.value = Math.max(0, u.uPrevMix.value - dt / 0.2);
      }
    }
  }

  // gravity is off while held, but collide() still runs so held props can't
  // clip walls. p.vel tracks the carry displacement so wall response works.
  updateHeld(p, dt, carrier, h) {
    const step = Math.min(dt, 0.05);
    if (carrier.mode === 'attach' && carrier.quat && h) {
      const target = h.offPos.clone().applyQuaternion(carrier.quat).add(carrier.pos);
      if (h.beamT < 1) {
        // tractor beam: cubic ease-out toward the (moving) hand anchor; on
        // landing, latch the rotation offset so the rigid attach is seamless
        h.beamT = Math.min(1, h.beamT + dt / h.beamDur);
        const k = 1 - Math.pow(1 - h.beamT, 3);
        target.lerpVectors(h.beamFrom, target, k);
        if (h.beamT >= 1) h.offQuat.copy(carrier.quat).invert().multiply(p.mesh.quaternion);
      } else if (!p.debugPane) {
        p.mesh.quaternion.copy(carrier.quat).multiply(h.offQuat);
      }
      p.vel.copy(target).sub(p.mesh.position).divideScalar(Math.max(step, 1e-4));
      p.mesh.position.copy(target);
    } else {
      // no hull clamp on the target: clamping pops ~0.6m when the best-containing
      // hull flips mid-doorway. collide() already keeps the prop out of walls.
      const target = carrier.pos.clone().addScaledVector(carrier.viewDir, CARRY_DIST);
      p.vel.copy(target.sub(p.mesh.position).multiplyScalar(14));
      // step cap: an uncapped carry spring could sweep a prop clean through
      // the pillar between two hull clamps (fast look-turns tunneled it)
      tmpD.copy(p.vel).multiplyScalar(step);
      if (tmpD.length() > 0.4) tmpD.setLength(0.4);
      p.mesh.position.add(tmpD);
    }
    this.collide(p);
    // held props respect the furniture/statue colliders too - the kinematic
    // body ignores cannon statics, and the gravity gun could shove props
    // through benches
    const pos = p.mesh.position;
    for (const c of this.level.colliders) {
      // statues carry their true convex-hull planes (physics.js): sphere-vs-
      // convex pushout along the least-penetrated face. The old center
      // cylinder blocked approach mid-statue and let held props clip clean
      // through the extremities the cylinder never covered.
      if (c.hullPlanes) {
        let best = -1e9, bn = null;
        for (const pl of c.hullPlanes) {
          const dd = pl.x * pos.x + pl.y * pos.y + pl.z * pos.z + pl.d;
          if (dd > best) { best = dd; bn = pl; }
        }
        const r = p.radius * 0.7;
        if (bn && best < r) {
          pos.x += bn.x * (r - best);
          pos.y += bn.y * (r - best);
          pos.z += bn.z * (r - best);
        }
        continue;
      }
      if (c.h !== undefined && pos.y - p.rFloor > c.h) continue; // clear above it
      const dx = pos.x - c.x, dz = pos.z - c.z;
      const min = (c.rx !== undefined ? Math.max(c.rx, c.rz) : c.r) + p.radius * 0.7;
      const dist = Math.hypot(dx, dz);
      if (dist < min && dist > 1e-5) {
        pos.x += dx / dist * (min - dist);
        pos.z += dz / dist * (min - dist);
      }
    }
    if (p.debugPane) p.mesh.lookAt(carrier.eye || carrier.pos);
  }

  collide(p) {
    const cell = this.level.cells[p.cell];
    const pos = p.mesh.position;
    let onFloor = false;
    let contacts = 0; // plane-index bitmask (hull cells have far fewer than 32 planes)
    for (let idx = 0; idx < cell.planes.length; idx++) {
      const pl = cell.planes[idx];
      // floor rests at the model's true base height; walls use the sphere
      // bound. Doored hull planes sit at MID-wall (portal coincidence), so
      // they need the half-thickness back or held props sink into the wall.
      const rad = (pl.n.y > 0.5 ? p.rFloor : p.radius) +
        (cell.doorPlanes && cell.doorPlanes.has(idx) ? WALL_T / 2 : 0);
      const d = pl.n.dot(pos) + pl.d;
      if (d >= rad) continue;
      let passable = false;
      for (const po of cell.portals) {
        if (po.planeIndex !== idx) continue;
        let edgeDist = Infinity;
        for (const ep of po.edgePlanes) edgeDist = Math.min(edgeDist, ep.n.dot(pos) + ep.d);
        if (edgeDist > p.radius * 0.5) { passable = true; break; }
      }
      if (passable) continue;
      contacts |= 1 << idx;
      pos.addScaledVector(pl.n, rad - d);
      const vn = pl.n.dot(p.vel);
      if (vn < 0) {
        p.vel.addScaledVector(pl.n, -vn * (1 + REST));
        // thunk only on NEW contact with this plane: the held-prop carry spring
        // re-penetrates every frame while pressed into a wall, and per-plane
        // (not per-prop) tracking keeps floor rest from muting a wall hit.
        // the cooldown backstops corner rattle alternating between two planes
        if (this.onImpact && vn < -0.5 && !(p.contacts & (1 << idx))) {
          const t = performance.now();
          if (t - (p.impactT || 0) > 120) { p.impactT = t; this.onImpact(pos, -vn, p); }
        }
      }
      if (pl.n.y > 0.5) onFloor = true;
    }
    p.contacts = contacts;
    return onFloor;
  }

  // returns the prop under the crosshair within reach, if any
  aim(eye, dir, reach = 3.5) {
    let best = null, bestT = reach;
    for (const p of this.list) {
      const oc = p.mesh.position.clone().sub(eye);
      const t = oc.dot(dir);
      if (t < 0.2 || t > reach) continue;
      const d2 = oc.lengthSq() - t * t;
      const rr = (p.radius + 0.08) ** 2;
      if (d2 < rr && t < bestT) { best = p; bestT = t; }
    }
    return best;
  }

  // nearest prop whose padded bounding sphere contains the point, if any
  touch(pos, pad = 0.06) {
    let best = null, bestD = pad;
    for (const p of this.list) {
      const d = p.mesh.position.distanceTo(pos) - p.radius;
      if (d < bestD) { best = p; bestD = d; }
    }
    return best;
  }

  // while held the body is kinematic: driven by the carry code, still pushes
  // other props, ignores forces (hull planes keep it out of walls)
  _bodyHold(p) {
    if (!p.body) return;
    p.body.type = CANNON.Body.KINEMATIC;
    p.body.velocity.setZero();
    p.body.angularVelocity.setZero();
    p.body.wakeUp();
  }

  _bodyFree(p, vel, spin = 0) {
    if (!p.body) return;
    p.body.type = CANNON.Body.DYNAMIC;
    p.body.velocity.set(vel.x, vel.y, vel.z);
    p.body.angularVelocity.set(
      (Math.random() - 0.5) * spin, (Math.random() - 0.5) * spin, (Math.random() - 0.5) * spin);
    p.body.wakeUp();
  }

  // claim p for `key`, stealing it from another hand if needed
  _take(p, key) {
    const prev = this.holderKey(p);
    if (prev) this.holds.delete(prev);
    this._bodyHold(p);
  }

  grab(p, key = 'desktop') {
    this._take(p, key);
    this.holds.set(key, { p, hold: null });
  }

  // rigid attach preserving the current hand-relative pose (direct VR grab,
  // hand-to-hand transfer): no snap-to-center
  grabAttach(p, carrier, key = 'desktop') {
    if (!carrier || !carrier.quat) return this.grab(p, key);
    this._take(p, key);
    const inv = carrier.quat.clone().invert();
    this.holds.set(key, { p, hold: {
      offPos: p.mesh.position.clone().sub(carrier.pos).applyQuaternion(inv),
      offQuat: inv.clone().multiply(p.mesh.quaternion),
      beamT: 1, beamDur: 1,
      beamFrom: new THREE.Vector3(),
    } });
  }

  // tractor beam: timed pull to HOLD_DIST in front of the hand, ending in a
  // rigid attach (offQuat is latched when the beam lands)
  grabBeam(p, carrier, key = 'desktop') {
    if (!carrier || !carrier.quat) return this.grab(p, key);
    this._take(p, key);
    const dist = p.mesh.position.distanceTo(carrier.pos);
    this.holds.set(key, { p, hold: {
      offPos: new THREE.Vector3(0, 0, -HOLD_DIST),
      offQuat: new THREE.Quaternion(),
      beamT: 0,
      beamDur: THREE.MathUtils.clamp(0.25 + dist * 0.07, 0.3, 0.5),
      beamFrom: p.mesh.position.clone(),
    } });
  }

  throwHeld(dir, playerVel) {
    const h = this.holds.get('desktop');
    if (!h) return;
    h.p.vel.copy(dir).multiplyScalar(9).add(playerVel);
    // a touch of spin makes thrown props read as free bodies immediately
    this._bodyFree(h.p, h.p.vel, 4);
    this.holds.delete('desktop');
  }

  dropHeld() {
    const h = this.holds.get('desktop');
    if (!h) return;
    h.p.vel.multiplyScalar(0.2);
    this._bodyFree(h.p, h.p.vel, 0); // no spin: drops should be calm
    this.holds.delete('desktop');
  }

  dropAll() { // session end: park everything in place
    for (const [key, h] of this.holds) {
      h.p.vel.multiplyScalar(0.2);
      this._bodyFree(h.p, h.p.vel, 0);
    }
    this.holds.clear();
  }

  // VR release: the hand's tracked world velocity carries the throw.
  // angVel (rad/s, optional): the wrist's real angular velocity - the prop
  // leaves spinning the way the hand was turning instead of with random spin
  release(vel, angVel = null, key = 'desktop') {
    const h = this.holds.get(key);
    if (!h) return;
    h.p.vel.copy(vel);
    if (angVel) {
      this._bodyFree(h.p, vel, 0);
      if (h.p.body) h.p.body.angularVelocity.set(angVel.x, angVel.y, angVel.z);
    } else {
      this._bodyFree(h.p, vel, 1.5);
    }
    this.holds.delete(key);
  }
}
