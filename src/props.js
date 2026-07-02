// Carryable props (gravity-gun style) with hull-plane physics.
// Diffuse / chrome / glass spheres + cube versions. The glass material samples
// the environment along the negated reflection vector (the HL:Alyx bottle trick),
// which makes it a razor-sharp probe of environment-approximation quality.
import * as THREE from 'three';
import { findCell } from './level.js';

const GRAVITY = 9.8;
const REST = 0.35;

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
        cell: mp.cell,
        asleep: true,
        debugPane: false,
      });
    }
  }

  update(dt, player) {
    for (const p of this.list) {
      if (p === this.held) {
        // no hull clamp on the target: clamping pops ~0.6m when the best-containing
        // hull flips mid-doorway. collide() already keeps the prop out of walls.
        const target = player.pos.clone().addScaledVector(player.viewDir, 1.9);
        p.vel.copy(target.sub(p.mesh.position).multiplyScalar(14));
        const step = Math.min(dt, 0.05);
        p.mesh.position.addScaledVector(p.vel, step);
        this.collide(p);
        if (p.debugPane) p.mesh.lookAt(player.pos);
      } else if (!p.asleep) {
        p.vel.y -= GRAVITY * dt;
        p.mesh.position.addScaledVector(p.vel, dt);
        const onFloor = this.collide(p);
        if (onFloor) {
          p.vel.x *= Math.pow(0.05, dt); // ground friction
          p.vel.z *= Math.pow(0.05, dt);
          if (p.vel.lengthSq() < 0.02) { p.vel.set(0, 0, 0); p.asleep = true; }
        }
      }
      const pos = p.mesh.position;
      p.cell = findCell(this.level.cells, pos, p.cell);
      for (const m of p.mats) {
        this.matsys.setMaterialCell(m, p.cell); // arms a 0.2s diffuse crossfade on change
        const u = m.uniforms;
        if (u.uPrevMix.value > 0) u.uPrevMix.value = Math.max(0, u.uPrevMix.value - dt / 0.2);
      }
    }
  }

  collide(p) {
    const cell = this.level.cells[p.cell];
    const pos = p.mesh.position;
    let onFloor = false;
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
      pos.addScaledVector(pl.n, rad - d);
      const vn = pl.n.dot(p.vel);
      if (vn < 0) p.vel.addScaledVector(pl.n, -vn * (1 + REST));
      if (pl.n.y > 0.5) onFloor = true;
    }
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

  grab(p) { this.held = p; p.asleep = false; }

  throwHeld(dir, playerVel) {
    if (!this.held) return;
    this.held.vel.copy(dir).multiplyScalar(9).add(playerVel);
    this.held.asleep = false;
    this.held = null;
  }

  dropHeld() {
    if (!this.held) return;
    this.held.vel.multiplyScalar(0.2);
    this.held.asleep = false;
    this.held = null;
  }
}
