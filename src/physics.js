// cannon-es world for prop physics. Static geometry comes from the level
// build (wall pieces WITH their door holes, ceilings, furniture colliders) so
// props collide with benches, pedestals, pillars and door frames for free.
// The hull-plane solver in props.js survives only for the HELD prop (its
// body is kinematic; hull planes keep it out of walls, portal-aware).
import * as CANNON from '../libs/cannon-es.js';
import * as THREE from 'three';
import { OCCLUDER_PROXIES } from './proxies.js';

const FIXED_DT = 1 / 90;

export class PhysicsWorld {
  constructor(level) {
    this.world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.8, 0) });
    this.world.allowSleep = true;
    this.world.defaultContactMaterial.friction = 0.4;
    this.world.defaultContactMaterial.restitution = 0.32;

    // all floors sit at y = 0: one static plane
    const ground = new CANNON.Body({ type: CANNON.Body.STATIC });
    ground.addShape(new CANNON.Plane());
    ground.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    this.world.addBody(ground);

    // walls / ceilings collected during buildLevel
    for (const b of level.staticBoxes) this._staticBox(b.c, b.half, b.rotY);
    // furniture / statue colliders: MUST read at construction time - statue
    // colliders register in addStaticModels, which runs after buildLevel
    // (reading earlier silently skipped every statue)
    for (const cc of level.colliders) {
      const h = cc.h !== undefined ? cc.h : 1.4; // statues: body-height box
      this._staticBox(
        [cc.x, h / 2, cc.z],
        [cc.rx || cc.r * 0.8, h / 2, cc.rz || cc.r * 0.8],
        cc.rot || 0);
    }
  }

  _staticBox(c, half, rotY = 0) {
    const body = new CANNON.Body({ type: CANNON.Body.STATIC });
    body.addShape(new CANNON.Box(new CANNON.Vec3(half[0], half[1], half[2])));
    body.position.set(c[0], c[1], c[2]);
    if (rotY) body.quaternion.setFromEuler(0, rotY, 0);
    this.world.addBody(body);
  }

  // dynamic body for a prop: sphere for balls, box for cubes/pane, and for
  // gltf exhibits a compound of spheres strung along the HAND-AUTHORED
  // occluder capsules (proxies.js) - physics matches what reflections and AO
  // already represent, and tight shapes fit through doorways (the full-bbox
  // box wedged the coffee cart in doors). Bbox box is the no-proxy fallback.
  addProp(p, onImpact) {
    const body = new CANNON.Body({ mass: Math.max(0.3, p.radius ** 3 * 40) });
    const proxy = p.slug && OCCLUDER_PROXIES.props[p.slug];
    if (p.round) {
      body.addShape(new CANNON.Sphere(p.radius));
    } else if (p.boxHalf) {
      body.addShape(new CANNON.Box(new CANNON.Vec3(...p.boxHalf)));
    } else if (proxy) {
      for (const [a, b, r] of proxy.capsules) {
        const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b);
        const len = A.distanceTo(B);
        const n = Math.min(4, Math.max(2, Math.ceil(len / Math.max(r, 0.03)) + 1));
        for (let k = 0; k < n; k++) {
          const q = A.clone().lerp(B, n === 1 ? 0 : k / (n - 1));
          body.addShape(new CANNON.Sphere(r), new CANNON.Vec3(q.x, q.y, q.z));
        }
      }
    } else {
      // no authored proxy: box from the world bbox at spawn (spawns unrotated)
      const bb = new THREE.Box3().setFromObject(p.mesh);
      const size = bb.getSize(new THREE.Vector3());
      const ctr = bb.getCenter(new THREE.Vector3()).sub(p.mesh.position);
      body.addShape(
        new CANNON.Box(new CANNON.Vec3(Math.max(size.x / 2, 0.03), Math.max(size.y / 2, 0.03), Math.max(size.z / 2, 0.03))),
        new CANNON.Vec3(ctr.x, ctr.y, ctr.z));
    }
    body.position.copy(p.mesh.position);
    body.quaternion.copy(p.mesh.quaternion);
    body.allowSleep = true;
    body.sleepSpeedLimit = 0.3;
    body.sleepTimeLimit = 0.6;
    body.angularDamping = 0.25;
    body.linearDamping = 0.02;
    body.addEventListener('collide', e => {
      const speed = Math.abs(e.contact.getImpactVelocityAlongNormal());
      if (speed > 0.5 && onImpact) onImpact(p, speed);
    });
    this.world.addBody(body);
    body.sleep(); // exhibits spawn at rest (on pedestals etc.)
    return body;
  }

  step(dt) {
    this.world.step(FIXED_DT, dt, 4);
  }
}
