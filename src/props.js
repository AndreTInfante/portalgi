// Carryable props (gravity-gun style) with hull-plane physics.
// Diffuse / chrome / glass spheres + cube versions. The glass material samples
// the environment along the negated reflection vector (the HL:Alyx bottle trick),
// which makes it a razor-sharp probe of environment-approximation quality.
import * as THREE from 'three';
import { findCell } from './level.js';

const GRAVITY = 9.8;
const REST = 0.35;
const tmpV1 = new THREE.Vector3(), tmpV2 = new THREE.Vector3(), tmpV3 = new THREE.Vector3();
const tmpQ2 = new THREE.Quaternion();
const HOLD_DIST = 0.12;  // rigid-attach rest offset in front of the hand (VR)
const CARRY_DIST = 1.9;  // ray-carry distance in front of the eye (desktop)

const PROP_DEFS = [
  // mode 4 = dynamic PBR prop: probe-grid diffuse + traversal specular
  { shape: 'sphere', mode: 4, x: -2.5, z: 1.4, tint: [0.85, 0.83, 0.8], roughFactor: 0.8, metalFactor: 0 },
  { shape: 'sphere', mode: 4, x: 0, z: 1.4, tint: [0.95, 0.96, 0.97], roughFactor: 0.04, metalFactor: 1 }, // chrome
  { shape: 'sphere', mode: 2, x: 2.5, z: 1.4 },
  { shape: 'cube', mode: 4, x: -2.5, z: -1.4, tint: [0.85, 0.4, 0.3], roughFactor: 0.8, metalFactor: 0 },
  { shape: 'cube', mode: 4, x: 0, z: -1.4, tint: [0.95, 0.96, 0.97], roughFactor: 0.04, metalFactor: 1 },
  { shape: 'cube', mode: 2, x: 2.5, z: -1.4 },
  // debug pane: near-clear glass, billboards to the camera while held -
  // hold it over scene geometry to see the hull approximation error directly.
  { shape: 'pane', mode: 3, x: 0.45, z: -2.8, y: 0.965, debugPane: true },
];

export class Props {
  constructor(scene, level, matsys, modelProps = []) {
    this.level = level;
    this.matsys = matsys;
    this.held = null;
    this.hold = null; // attach state for the held prop: hand-space offsets + beam progress
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
      return {
        mesh, mats: [mat], radius: r, rFloor: r,
        vel: new THREE.Vector3(),
        angVel: new THREE.Vector3(),
        round: def.shape === 'sphere', // rolls; boxy props damp their spin fast
        cell: 0,
        asleep: true,
        debugPane: !!def.debugPane,
      };
    });
    // imported glTF exhibits - same physics, multiple materials per prop
    for (const mp of modelProps) {
      scene.add(mp.root);
      this.list.push({
        mesh: mp.root, mats: mp.mats, radius: mp.radius, rFloor: mp.rFloor,
        vel: new THREE.Vector3(),
        angVel: new THREE.Vector3(),
        round: false,
        cell: mp.cell,
        asleep: true,
        debugPane: false,
        slug: mp.slug, // authored occluder proxy key (proxies.js)
      });
    }
  }

  // carrier: { pos, quat (Quaternion|null), viewDir, vel, eye?, mode? }.
  // mode 'attach' = rigid follow via hand-space offsets (VR controllers);
  // anything else = the desktop ray-carry spring. The desktop Player instance
  // itself is a valid carrier (no quat/mode -> ray path).
  update(dt, carrier) {
    this.collidePairs(dt);
    for (const p of this.list) {
      if (p === this.held) {
        this.updateHeld(p, dt, carrier);
      } else if (!p.asleep) {
        p.vel.y -= GRAVITY * dt;
        p.mesh.position.addScaledVector(p.vel, dt);
        const onFloor = this.collide(p);
        if (onFloor) {
          p.vel.x *= Math.pow(0.05, dt); // ground friction
          p.vel.z *= Math.pow(0.05, dt);
          if (p.round) {
            // rolling couples spin to travel (w = up x v / r); the visual
            // sells the physics
            tmpV1.set(p.vel.z / p.radius, 0, -p.vel.x / p.radius);
            p.angVel.lerp(tmpV1, Math.min(1, dt * 6));
          }
          if (p.vel.lengthSq() < 0.02) { p.vel.set(0, 0, 0); p.asleep = true; }
        }
        this.spin(p, dt, onFloor);
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

  // integrate angular velocity into orientation; boxy props kill their spin
  // quickly on the ground (no orientation constraints - fast damping stands in
  // for "settling flat"), round ones keep rolling
  spin(p, dt, onFloor) {
    const w = p.angVel.lengthSq();
    if (w < 1e-5) return;
    const mag = Math.sqrt(w);
    tmpQ2.setFromAxisAngle(tmpV1.copy(p.angVel).divideScalar(mag), mag * dt);
    p.mesh.quaternion.premultiply(tmpQ2);
    const damp = onFloor && !p.round ? 0.002 : onFloor ? 0.6 : 0.25;
    p.angVel.multiplyScalar(Math.pow(damp, dt));
  }

  // sphere-sphere prop collisions: positional separation + impulse along the
  // contact normal (mass ~ r^3), tangential slip becomes tumble. The held
  // prop acts kinematic: it displaces others but is not displaced.
  collidePairs(dt) {
    const L = this.list;
    for (let i = 0; i < L.length; i++) {
      for (let j = i + 1; j < L.length; j++) {
        const a = L[i], b = L[j];
        if (a.asleep && b.asleep) continue;
        if (a.debugPane || b.debugPane) continue;
        const n = tmpV1.copy(b.mesh.position).sub(a.mesh.position);
        const rSum = a.radius + b.radius;
        const d2 = n.lengthSq();
        if (d2 >= rSum * rSum || d2 < 1e-8) continue;
        const d = Math.sqrt(d2);
        n.divideScalar(d);
        const overlap = rSum - d;
        const ma = a === this.held ? 1e6 : a.radius ** 3;
        const mb = b === this.held ? 1e6 : b.radius ** 3;
        const wa = mb / (ma + mb), wb = ma / (ma + mb);
        a.mesh.position.addScaledVector(n, -overlap * wa);
        b.mesh.position.addScaledVector(n, overlap * wb);
        const rel = tmpV2.copy(a.vel).sub(b.vel);
        const vn = rel.dot(n);
        if (vn > 0) {
          const imp = vn * (1 + REST);
          a.vel.addScaledVector(n, -imp * wa);
          b.vel.addScaledVector(n, imp * wb);
          // tangential slip -> tumble on both bodies
          tmpV2.addScaledVector(n, -vn); // rel velocity tangent
          tmpV3.crossVectors(n, tmpV2);
          a.angVel.addScaledVector(tmpV3, 0.6 / Math.max(a.radius, 0.08));
          b.angVel.addScaledVector(tmpV3, 0.6 / Math.max(b.radius, 0.08));
          if (a.asleep) a.asleep = false;
          if (b.asleep) b.asleep = false;
          if (this.onImpact && vn > 0.5) {
            const big = a.radius > b.radius ? a : b;
            const t = performance.now();
            if (t - (big.impactT || 0) > 120) {
              big.impactT = t;
              this.onImpact(tmpV2.copy(a.mesh.position).addScaledVector(n, a.radius), vn, big);
            }
          }
        } else if (a.asleep !== b.asleep) {
          // resting overlap from a push: wake the sleeper so it can settle
          (a.asleep ? a : b).asleep = false;
        }
      }
    }
  }

  // gravity is off while held, but collide() still runs so held props can't
  // clip walls. p.vel tracks the carry displacement so wall response works.
  updateHeld(p, dt, carrier) {
    const step = Math.min(dt, 0.05);
    const h = this.hold;
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
      p.mesh.position.addScaledVector(p.vel, step);
    }
    this.collide(p);
    if (p.debugPane) p.mesh.lookAt(carrier.eye || carrier.pos);
  }

  collide(p) {
    const cell = this.level.cells[p.cell];
    const pos = p.mesh.position;
    let onFloor = false;
    let contacts = 0; // plane-index bitmask (hull cells have far fewer than 32 planes)
    for (let idx = 0; idx < cell.planes.length; idx++) {
      const pl = cell.planes[idx];
      // floor rests at the model's true base height; walls use the sphere bound
      const rad = pl.n.y > 0.5 ? p.rFloor : p.radius;
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
        // tangential slip at the contact becomes tumble (pre-reflection vel)
        tmpV3.copy(p.vel).addScaledVector(pl.n, -vn);
        tmpV1.crossVectors(pl.n, tmpV3);
        p.angVel.addScaledVector(tmpV1, 0.5 / Math.max(p.radius, 0.08));
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

  grab(p) { this.held = p; this.hold = null; p.asleep = false; }

  // rigid attach preserving the current hand-relative pose (direct VR grab,
  // hand-to-hand transfer): no snap-to-center
  grabAttach(p, carrier) {
    if (!carrier || !carrier.quat) return this.grab(p);
    this.held = p;
    p.asleep = false;
    const inv = carrier.quat.clone().invert();
    this.hold = {
      offPos: p.mesh.position.clone().sub(carrier.pos).applyQuaternion(inv),
      offQuat: inv.clone().multiply(p.mesh.quaternion),
      beamT: 1, beamDur: 1,
      beamFrom: new THREE.Vector3(),
    };
  }

  // tractor beam: timed pull to HOLD_DIST in front of the hand, ending in a
  // rigid attach (offQuat is latched when the beam lands)
  grabBeam(p, carrier) {
    if (!carrier || !carrier.quat) return this.grab(p);
    this.held = p;
    p.asleep = false;
    const dist = p.mesh.position.distanceTo(carrier.pos);
    this.hold = {
      offPos: new THREE.Vector3(0, 0, -HOLD_DIST),
      offQuat: new THREE.Quaternion(),
      beamT: 0,
      beamDur: THREE.MathUtils.clamp(0.25 + dist * 0.07, 0.3, 0.5),
      beamFrom: p.mesh.position.clone(),
    };
  }

  throwHeld(dir, playerVel) {
    if (!this.held) return;
    this.held.vel.copy(dir).multiplyScalar(9).add(playerVel);
    // a touch of spin makes thrown props read as free bodies immediately
    this.held.angVel.set((Math.random() - 0.5) * 4, (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 4);
    this.held.asleep = false;
    this.held = null;
    this.hold = null;
  }

  dropHeld() {
    if (!this.held) return;
    this.held.vel.multiplyScalar(0.2);
    this.held.asleep = false;
    this.held = null;
    this.hold = null;
  }

  // VR release: the hand's tracked world velocity carries the throw
  release(vel) {
    if (!this.held) return;
    this.held.vel.copy(vel);
    this.held.asleep = false;
    this.held = null;
    this.hold = null;
  }
}
