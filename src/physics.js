// cannon-es world for prop physics. Static geometry comes from the level
// build (wall pieces WITH their door holes, ceilings, furniture colliders) so
// props collide with benches, pedestals, pillars and door frames for free.
// The hull-plane solver in props.js survives only for the HELD prop (its
// body is kinematic; hull planes keep it out of walls, portal-aware).
import * as CANNON from '../libs/cannon-es.js';
import * as THREE from 'three';
import { ConvexHull } from '../libs/math/ConvexHull.js';
import { OCCLUDER_PROXIES } from './proxies.js';

// prop-local convex hull of the REAL mesh vertices -> cannon ConvexPolyhedron.
// Replaces the capsule-compound approximation (authored capsules are tuned
// for reflection blobs, not contact: chairs wobbled on sphere strings). The
// hull's bottom face spans the leg tips, so furniture gets its flat resting
// base for free. Points are quantized to a 4cm grid before hulling to keep
// the vertex count (and cannon's convex-convex narrowphase) small.
export function convexFromMesh(root) {
  root.updateMatrixWorld(true);
  // body space = root position+rotation WITHOUT scale (cannon shapes carry
  // no scale, but the body tracks mesh position/quaternion only) - any root
  // scale must bake into the hull points
  const rootInv = new THREE.Matrix4()
    .compose(root.position, root.quaternion, new THREE.Vector3(1, 1, 1))
    .invert();
  const v = new THREE.Vector3();
  const seen = new Set();
  const pts = [];
  root.traverse(o => {
    if (!o.isMesh) return;
    const pos = o.geometry.getAttribute('position');
    const m = new THREE.Matrix4().multiplyMatrices(rootInv, o.matrixWorld);
    const step = Math.max(1, Math.floor(pos.count / 600));
    for (let i = 0; i < pos.count; i += step) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m);
      const k = ((Math.round(v.x * 25) + 512) << 20) |
                ((Math.round(v.y * 25) + 512) << 10) |
                 (Math.round(v.z * 25) + 512);
      if (seen.has(k)) continue;
      seen.add(k);
      pts.push(v.clone());
    }
  });
  if (pts.length < 8) return null;
  try {
    const hull = new ConvexHull().setFromPoints(pts);
    const idOf = new Map();
    const verts = [];
    const faces = [];
    for (const f of hull.faces) {
      const idx = [];
      let e = f.edge;
      do {
        const pt = e.head().point;
        let id = idOf.get(pt);
        if (id === undefined) {
          id = verts.length;
          idOf.set(pt, id);
          verts.push(new CANNON.Vec3(pt.x, pt.y, pt.z));
        }
        idx.push(id);
        e = e.next;
      } while (e !== f.edge);
      faces.push(idx);
    }
    return new CANNON.ConvexPolyhedron({ vertices: verts, faces });
  } catch (err) {
    console.warn('physics: convex hull failed, capsule fallback:', err.message);
    return null;
  }
}

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
      // statics with mesh-fit physics spheres (statues, plants): world-space
      // vertical band fit computed at model load. NOT the authored occluder
      // capsules - those are tuned for reflection blobs, and their artistic
      // shapes left props proud of fat blobs and inside uncovered parts.
      if (cc.physSpheres && cc.physSpheres.length) {
        const body = new CANNON.Body({ type: CANNON.Body.STATIC });
        for (const [x, y, z, r] of cc.physSpheres) {
          body.addShape(new CANNON.Sphere(r), new CANNON.Vec3(x, y, z));
        }
        this.world.addBody(body);
        continue;
      }
      const h = cc.h !== undefined ? cc.h : 1.4; // fallback: body-height box
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
  // gltf exhibits a CONVEX HULL of the real mesh (convexFromMesh above) -
  // contact matches what the eye sees, and the hull base is flat across the
  // leg tips so furniture rests straight. Authored occluder capsules remain
  // the fallback (they stay the reflection/AO representation regardless);
  // bbox box is the last resort.
  addProp(p, onImpact) {
    const body = new CANNON.Body({ mass: Math.max(0.3, p.radius ** 3 * 40) });
    const proxy = p.slug && OCCLUDER_PROXIES.props[p.slug];
    const hull = !p.round && !p.boxHalf && p.slug ? convexFromMesh(p.mesh) : null;
    if (p.round) {
      body.addShape(new CANNON.Sphere(p.radius));
    } else if (p.boxHalf) {
      body.addShape(new CANNON.Box(new CANNON.Vec3(...p.boxHalf)));
    } else if (hull) {
      body.addShape(hull);
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
      // flat foot: sphere compounds have no stable ground plane, so chairs
      // and the cart never settled straight once disturbed. A thin box at
      // the rest base (rFloor below the root) gives a real contact patch.
      const bb = new THREE.Box3().setFromObject(p.mesh);
      const size = bb.getSize(new THREE.Vector3());
      body.addShape(
        new CANNON.Box(new CANNON.Vec3(
          Math.max(size.x * 0.3, 0.05), 0.025, Math.max(size.z * 0.3, 0.05))),
        new CANNON.Vec3(0, -p.rFloor + 0.025, 0));
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
