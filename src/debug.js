// lil-gui panel wired to the shared shader globals + portal wireframe overlay.
import * as THREE from 'three';
import * as CANNON from '../libs/cannon-es.js';
import GUI from 'lil-gui';

// wireframes for every cannon collision shape (statics steel-blue, dynamics
// orange): the ground-truth view of what physics actually collides against -
// authored proxies, mesh-fit statue spheres, and prop convex hulls all
// diverge from the visual mesh in their own ways
export function buildPhysicsWires(world) {
  const group = new THREE.Group();
  group.visible = false;
  const dyn = []; // [{ body, obj }] - only dynamics need per-frame sync
  const matS = new THREE.LineBasicMaterial({ color: 0x4d9fd6, depthTest: false, transparent: true, opacity: 0.7 });
  const matD = new THREE.LineBasicMaterial({ color: 0xff9a3d, depthTest: false, transparent: true, opacity: 0.9 });
  const shapeWire = (shape, mat) => {
    if (shape instanceof CANNON.Sphere) {
      return new THREE.LineSegments(
        new THREE.WireframeGeometry(new THREE.SphereGeometry(shape.radius, 10, 6)), mat);
    }
    if (shape instanceof CANNON.Box) {
      const h = shape.halfExtents;
      return new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(h.x * 2, h.y * 2, h.z * 2)), mat);
    }
    if (shape instanceof CANNON.ConvexPolyhedron) {
      const pts = [];
      for (const face of shape.faces) {
        for (let i = 0; i < face.length; i++) {
          const a = shape.vertices[face[i]], b = shape.vertices[face[(i + 1) % face.length]];
          pts.push(new THREE.Vector3(a.x, a.y, a.z), new THREE.Vector3(b.x, b.y, b.z));
        }
      }
      return new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), mat);
    }
    return null; // planes etc.
  };
  for (const body of world.bodies) {
    const isDyn = body.type === CANNON.Body.DYNAMIC || body.type === CANNON.Body.KINEMATIC;
    const obj = new THREE.Group();
    let any = false;
    for (let i = 0; i < body.shapes.length; i++) {
      const w = shapeWire(body.shapes[i], isDyn ? matD : matS);
      if (!w) continue;
      any = true;
      w.position.copy(body.shapeOffsets[i]);
      w.quaternion.copy(body.shapeOrientations[i]);
      w.layers.set(3); // debug-only: out of cubemap captures
      obj.add(w);
    }
    if (!any) continue;
    obj.position.copy(body.position);
    obj.quaternion.copy(body.quaternion);
    group.add(obj);
    if (isDyn) dyn.push({ body, obj });
  }
  // shape census: a missing CLASS of collider (e.g. the statue sphere
  // bands) is invisible in gameplay until something falls through it
  const census = { sphere: 0, box: 0, hull: 0, plane: 0 };
  for (const b of world.bodies) {
    for (const s of b.shapes) {
      census[s instanceof CANNON.Sphere ? 'sphere' : s instanceof CANNON.Box ? 'box'
        : s instanceof CANNON.ConvexPolyhedron ? 'hull' : 'plane']++;
    }
  }
  console.log(`physics: ${world.bodies.length} bodies -`,
    JSON.stringify(census));
  return {
    group,
    update() { // call per frame while visible
      for (const d of dyn) {
        d.obj.position.copy(d.body.position);
        d.obj.quaternion.copy(d.body.quaternion);
      }
    },
  };
}

export function buildPortalWires(scene, level) {
  const group = new THREE.Group();
  group.visible = false;
  for (const cell of level.cells) {
    const color = new THREE.Color().setHSL((cell.id * 0.618) % 1, 0.7, 0.55);
    const pts = [];
    for (const po of cell.portals) {
      const n = cell.planes[po.planeIndex].n;
      // mutual portals are geometrically coincident; inset each side's outline
      // laterally by a different amount (cell-id parity) so pairs read as
      // concentric rectangles instead of z-fighting or fake misalignment
      const ctr = po.corners[0].clone().add(po.corners[1]).add(po.corners[2]).add(po.corners[3]).multiplyScalar(0.25);
      const inset = 0.02 + (cell.id % 2) * 0.035;
      const c = po.corners.map(v => {
        const p = v.clone().addScaledVector(n, 0.008);
        return p.add(ctr.clone().sub(v).normalize().multiplyScalar(inset));
      });
      for (let i = 0; i < 4; i++) { pts.push(c[i], c[(i + 1) % 4]); }
    }
    if (pts.length) {
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const ls = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color, depthTest: true }));
      ls.layers.set(3); // debug-only: keep out of cubemap captures
      group.add(ls);
    }
  }
  scene.add(group);
  return group;
}

export function buildGUI(matsys, state, wires, onRebake, onRelight, culler, onStaticImposters, perf, audio, physWires) {
  const gui = new GUI({ title: 'PortalIBL' });
  // ?dev=1 reveals the internal tools (perf sweeps, bake buttons); the public
  // deploy shows only the demo-facing folders
  const DEV = new URLSearchParams(location.search).has('dev');
  const g = matsys.globals;
  const proxy = {
    get steps() { return g.uMaxSteps.value; }, set steps(v) { g.uMaxSteps.value = v; },
    get roughHops() { return g.uRoughHops.value > 0.5; }, set roughHops(v) { g.uRoughHops.value = v ? 1 : 0; },
    get edgeBlend() { return g.uBlendOn.value > 0.5; }, set edgeBlend(v) { g.uBlendOn.value = v ? 1 : 0; },
    get blendBase() { return g.uBlendBase.value; }, set blendBase(v) { g.uBlendBase.value = v; },
    get blendRough() { return g.uBlendRough.value; }, set blendRough(v) { g.uBlendRough.value = v; },
    get distRough() { return g.uDistRough.value; }, set distRough(v) { g.uDistRough.value = v; },
    get exposure() { return Math.log2(g.uExposure.value); }, set exposure(v) { g.uExposure.value = Math.pow(2, v); },
    get view() { return g.uDebugMode.value; },
    set view(v) {
      g.uDebugMode.value = v;
      // debug views live in separate programs (step accumulator = register
      // pressure); swapping causes a one-off rebuild hitch
      if (matsys.setDebugCompiled) matsys.setDebugCompiled(v > 0);
    },
    get portals() { return wires.visible; }, set portals(v) { wires.visible = v; },
  };
  const f1 = gui.addFolder('Traversal');
  // floors/props run ONE unrolled hop (hop1); these two only steer the full
  // multi-hop march used in glass/chrome (0 = PCCM everywhere)
  f1.add(proxy, 'steps', 0, 6, 1).name('portal hops (glass; 0=PCCM)');
  f1.add(proxy, 'roughHops').name('rough-scaled hops (glass)');
  f1.add(proxy, 'edgeBlend').name('edge blend');
  f1.add(proxy, 'blendBase', 0, 0.4, 0.01).name('blend width base (m)');
  f1.add(proxy, 'blendRough', 0, 3, 0.05).name('portal de-aliasing bias');
  f1.add(proxy, 'distRough', 0, 2, 0.05).name('rough growth (1=physical)');
  const f2 = gui.addFolder('Display');
  f2.add(proxy, 'exposure', -5, 2, 0.1).name('exposure (EV)');
  f2.add(proxy, 'view', { None: 0, 'Cell tint': 1, 'Step heatmap': 2, 'Irradiance only': 3, 'White world': 4, Lightmap: 5, 'Specular only (8x)': 6 });
  f2.add(proxy, 'portals').name('show portals');
  if (physWires) f2.add(physWires.group, 'visible').name('show collision shapes');
  if (culler) f2.add(culler, 'enabled').name('portal culling');
  if (typeof window !== 'undefined' && window.__setFbScale) {
    f2.add({ fb: 0.9 }, 'fb', 0.6, 1.2, 0.05).name('eye buffer scale (re-enter VR)')
      .onChange(v => window.__setFbScale(v));
  }
  if (onStaticImposters) f2.add({ si: true }, 'si').name('statues via proxies (rebakes)').onChange(onStaticImposters);
  {
    // occluders split by receiver: STATICS read the texture-space layer
    // (dynocc.js splat - ao/shadow dials feed it live), PROPS evaluate the
    // capsules per VERTEX, reflections march occSegment. One switch, one
    // set of dials, three consumers.
    const fo = gui.addFolder('Occluders');
    const op = {
      get on() { return g.uOccOn.value > 0.5; }, set on(v) { g.uOccOn.value = v ? 1 : 0; },
      get density() { return g.uOccDensity.value; }, set density(v) { g.uOccDensity.value = v; },
      get widen() { return g.uOccWiden.value; }, set widen(v) { g.uOccWiden.value = v; },
      get hops() { return g.uOccHops.value; }, set hops(v) { g.uOccHops.value = v; },
      get tint() { return g.uOccTint.value; }, set tint(v) { g.uOccTint.value = v; },
      get lod() { return g.uOccLod.value; }, set lod(v) { g.uOccLod.value = v; },
    };
    fo.add(op, 'on').name('occluders (AO+shadows+blobs)');
    fo.add(op, 'density', 0, 3, 0.01).name('blob density');
    fo.add(op, 'widen', 0, 2, 0.01).name('blob cone / rough-m');
    fo.add(op, 'tint', 0, 1, 0.01).name('blob diffuse re-emit');
    fo.add(op, 'lod', 0, 6, 0.25).name('blob LOD (0=always march)');
    fo.add(op, 'hops', 0, 4, 1).name('blob hops (glass walk)');
    fo.add({ get ao() { return g.uOccAO.value; }, set ao(v) { g.uOccAO.value = v; } },
      'ao', 0, 1.5, 0.01).name('contact AO');
    fo.add({ get ac() { return g.uOccAOClamp.value; }, set ac(v) { g.uOccAOClamp.value = v; } },
      'ac', 0, 0.2, 0.005).name('AO min distance (m)');
    fo.add({ get sh() { return g.uOccShadow.value; }, set sh(v) { g.uOccShadow.value = v; } },
      'sh', 0, 1, 0.01).name('dyn shadows');
    fo.add({ get mc() { return g.uOccBudget.value; }, set mc(v) { g.uOccBudget.value = v; } },
      'mc', 0, 32, 1).name('dyn capsule budget (pack)');
    // range gates only prop-receiver effects + reflection blobs; the
    // static layer has no view fade (texel-bounded)
    fo.add({ get rg() { return g.uOccRange.value; }, set rg(v) { g.uOccRange.value = v; } },
      'rg', 4, 100, 1).name('dyn range (props+blobs, m)');
    fo.add({ dump: () => {
      const j = JSON.stringify({ density: g.uOccDensity.value,
        widen: g.uOccWiden.value, tint: g.uOccTint.value, hops: g.uOccHops.value,
        lod: g.uOccLod.value, ao: g.uOccAO.value, aoClamp: g.uOccAOClamp.value,
        shadow: g.uOccShadow.value, distRough: g.uDistRough.value }, null, 2);
      console.log('occluder params:', j);
      if (navigator.clipboard) navigator.clipboard.writeText(j).catch(() => {});
    } }, 'dump').name('DUMP values (console+clipboard)');
  }
  if (audio) {
    const fa = gui.addFolder('Audio');
    fa.add(audio, 'master', 0, 1, 0.01).name('master volume');
    fa.add(audio, 'music', 0, 0.2, 0.005).name('music volume');
    fa.add(audio, 'sfx', 0, 1, 0.01).name('sfx volume');
    fa.close();
  }
  if (perf && DEV) {
    const fp = gui.addFolder('Perf');
    const pp = { get burn() { return perf.burn; }, set burn(v) { perf.setBurn(v); } };
    fp.add(pp, 'burn', 0, 600, 5).name('burn (units)');
    fp.add(perf, 'step', 5, 60, 5).name('sweep step');
    fp.add(perf, 'threshold', 1, 20, 1).name('tip threshold %');
    fp.add({ batch: () => {
      if (perf.batch || perf.sweep) { perf.cancelBatch(); return; }
      if (perf.batchSetup) { const b = perf.batchSetup(); perf.startBatch(b.configs, b.restore); }
    } }, 'batch').name('RUN FULL BATCH (B/Y in VR)');
    fp.add({ run: () => (perf.batch || perf.sweep) ? perf.cancelBatch()
      : perf.startSweep(perf.configFn ? perf.configFn() : '') }, 'run')
      .name('run/cancel single sweep');
    fp.add({ log: () => console.log(localStorage.getItem('perfLog') || '(no sweeps yet)') }, 'log')
      .name('print sweep log');
    fp.close();
  }
  if (DEV) {
    const f3 = gui.addFolder('Bake');
    f3.add(state, 'bounces', 1, 3, 1);
    if (onRelight) f3.add({ relight: onRelight }, 'relight').name('re-trace lightmap (L)');
    f3.add({ rebake: onRebake }, 'rebake').name('re-bake cubemaps (B)');
    f3.add({ offline: () => { location.search = '?bake=1'; } }, 'offline')
      .name('offline bake - baked/ (slow)');
  }
  return gui;
}
