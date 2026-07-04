// Occluder proxy authoring gallery (?proxyedit=1). Loads every prop and
// statue model at in-game scale in a grid, overlays SOLID colored capsules
// (start = authored set from proxies.js, else the auto-fit), and edits them
// with draggable GUI numbers + a color picker. DUMP emits the full
// OCCLUDER_PROXIES body to paste into proxies.js.
//
// Coordinates are the authoring-local frame documented in proxies.js:
// props are bbox-centered (origin = physics center), statics are grounded
// at y=0 and xz-centered - both exactly as the game constructs them.
import * as THREE from 'three';
import { GLTFLoader } from '../libs/loaders/GLTFLoader.js';
import { OrbitControls } from '../libs/controls/OrbitControls.js';
import { TransformControls } from '../libs/controls/TransformControls.js';
import GUI from 'lil-gui';
import { MODEL_DEFS, STATIC_MODEL_DEFS } from './models.js';
import { OCCLUDER_PROXIES } from './proxies.js';
import { fitCapsules, MAX_SPH_PER_PROP } from './occluders.js';

const DEFAULT_COLOR = { statics: [0.42, 0.4, 0.36], props: [0.35, 0.33, 0.3] };

export async function startProxyEditor(renderer) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1c1e24);
  const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.05, 200);
  camera.position.set(0, 2.2, 5);
  scene.add(new THREE.HemisphereLight(0xdde4ff, 0x3a3228, 1.1));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(4, 8, 5);
  scene.add(sun);
  scene.add(new THREE.GridHelper(60, 60, 0x555555, 0x2e3138));

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0.8, 0);

  const loader = new GLTFLoader();
  const items = [];
  const defs = [
    ...STATIC_MODEL_DEFS.map(d => ({ def: d, kind: 'statics' })),
    ...MODEL_DEFS.map(d => ({ def: d, kind: 'props' })),
  ];

  const COLS = 5, SPACING = 3.2;
  await Promise.all(defs.map(async ({ def, kind }, idx) => {
    let gltf;
    try {
      gltf = await loader.loadAsync(`./assets/models/gltf/${def.slug}/${def.slug}_1k.gltf`);
    } catch (e) {
      console.error(`proxyedit: load failed ${def.slug}`, e);
      return;
    }
    const inner = gltf.scene;
    const box = new THREE.Box3().setFromObject(inner);
    const dim = box.getSize(new THREE.Vector3());
    const scale = def.size / Math.max(dim.x, dim.y, dim.z);
    inner.scale.setScalar(scale);
    box.setFromObject(inner);
    const center = box.getCenter(new THREE.Vector3());
    // authoring-local frame: props bbox-centered; statics grounded + xz-centered
    const local = new THREE.Group();
    if (kind === 'props') {
      inner.position.sub(center);
    } else {
      inner.position.set(-center.x, -box.min.y, -center.z);
    }
    local.add(inner);
    // gallery placement: grid cell; lift props so they rest on the grid plane
    const holder = new THREE.Group();
    const gx = (idx % COLS - (COLS - 1) / 2) * SPACING;
    const gz = -Math.floor(idx / COLS) * SPACING;
    holder.position.set(gx, kind === 'props' ? center.y - box.min.y : 0, gz);
    holder.add(local);
    scene.add(holder);

    holder.updateMatrixWorld(true);
    const authored = OCCLUDER_PROXIES[kind][def.slug];
    const caps = authored
      ? authored.capsules.map(([a, b, r]) => ({
        a: new THREE.Vector3(...a), b: new THREE.Vector3(...b), r,
      }))
      : fitCapsules(local); // local frame of `local` == authoring frame
    const color = (authored && authored.color) || DEFAULT_COLOR[kind].slice();
    const item = {
      def, kind, holder, local, inner, caps,
      color: color.slice(),
      capMat: new THREE.MeshStandardMaterial({
        transparent: true, opacity: 0.35, roughness: 0.6, depthWrite: false,
      }),
      helpers: [],
      meshVisible: true,
    };
    item.capMat.color.setRGB(...item.color);
    items.push(item);
  }));
  items.sort((a, b) => defs.findIndex(d => d.def === a.def) - defs.findIndex(d => d.def === b.def));

  // capsule helper meshes (solid): cylinder body + two sphere caps, in the
  // item's LOCAL group so authored coords drive them directly
  const ensureHelpers = item => {
    while (item.helpers.length < item.caps.length) {
      const capIdx = item.helpers.length;
      const itemIdx = items.indexOf(item);
      const mk = geo => {
        const m = new THREE.Mesh(geo, item.capMat);
        m.matrixAutoUpdate = false;
        m.userData.pick = { itemIdx, capIdx }; // capsule picking
        item.local.add(m);
        return m;
      };
      item.helpers.push({
        cyl: mk(new THREE.CylinderGeometry(1, 1, 1, 14, 1, true)),
        sa: mk(new THREE.SphereGeometry(1, 14, 10)),
        sb: mk(new THREE.SphereGeometry(1, 14, 10)),
      });
    }
    while (item.helpers.length > item.caps.length) {
      const h = item.helpers.pop();
      for (const m of [h.cyl, h.sa, h.sb]) { item.local.remove(m); m.geometry.dispose(); }
    }
  };
  const UP = new THREE.Vector3(0, 1, 0), IQ = new THREE.Quaternion();
  const poseHelpers = item => {
    ensureHelpers(item);
    for (let i = 0; i < item.caps.length; i++) {
      const c = item.caps[i], h = item.helpers[i];
      const mid = new THREE.Vector3().addVectors(c.a, c.b).multiplyScalar(0.5);
      const dir = new THREE.Vector3().subVectors(c.b, c.a);
      const len = Math.max(dir.length(), 1e-4);
      const q = new THREE.Quaternion().setFromUnitVectors(UP, dir.normalize());
      h.cyl.matrix.compose(mid, q, new THREE.Vector3(c.r, len, c.r));
      h.sa.matrix.compose(c.a, IQ, new THREE.Vector3(c.r, c.r, c.r));
      h.sb.matrix.compose(c.b, IQ, new THREE.Vector3(c.r, c.r, c.r));
    }
  };
  for (const item of items) poseHelpers(item);

  // --------------------------------------------------- capsule gizmo + pick
  const gui = new GUI({ title: 'Proxy editor' });
  let sel = 0;
  let selCap = 0;
  let capFolder = null;

  const selMat = new THREE.MeshStandardMaterial({
    transparent: true, opacity: 0.85, roughness: 0.5, depthWrite: false,
    emissive: 0x1a5f38, emissiveIntensity: 0.8,
  });
  // gizmo proxy: midpoint position, Y-axis along the capsule, scale (r,len,r);
  // it lives in the item's LOCAL group so edits stay in the authoring frame
  const gizmoProxy = new THREE.Object3D();
  const tc = new TransformControls(camera, renderer.domElement);
  tc.setSize(0.8);
  scene.add(tc);
  tc.addEventListener('dragging-changed', e => { controls.enabled = !e.value; });

  const capsuleToProxy = () => {
    const c = items[sel].caps[selCap];
    const dir = new THREE.Vector3().subVectors(c.b, c.a);
    const len = dir.length();
    gizmoProxy.position.addVectors(c.a, c.b).multiplyScalar(0.5);
    gizmoProxy.quaternion.setFromUnitVectors(UP, len > 1e-5 ? dir.normalize() : UP);
    gizmoProxy.scale.set(c.r, Math.max(len, 1e-4), c.r);
  };
  const proxyToCapsule = () => {
    const item = items[sel];
    const c = item.caps[selCap];
    const r = (Math.abs(gizmoProxy.scale.x) + Math.abs(gizmoProxy.scale.z)) / 2;
    c.r = Math.max(0.02, r);
    gizmoProxy.scale.set(c.r, gizmoProxy.scale.y, c.r);
    const half = Math.max(Math.abs(gizmoProxy.scale.y), 1e-4) / 2;
    const dir = new THREE.Vector3(0, 1, 0).applyQuaternion(gizmoProxy.quaternion);
    c.a.copy(gizmoProxy.position).addScaledVector(dir, -half);
    c.b.copy(gizmoProxy.position).addScaledVector(dir, half);
    poseHelpers(item);
  };
  tc.addEventListener('objectChange', proxyToCapsule);

  const highlightCapsule = () => {
    for (const it of items) {
      for (let i = 0; i < it.helpers.length; i++) {
        const m = (it === items[sel] && i === selCap) ? selMat : it.capMat;
        const h = it.helpers[i];
        h.cyl.material = m; h.sa.material = m; h.sb.material = m;
      }
    }
    selMat.color.setRGB(...items[sel].color);
  };

  const attachGizmo = () => {
    const item = items[sel];
    selCap = Math.min(selCap, item.caps.length - 1);
    item.local.add(gizmoProxy);
    capsuleToProxy();
    tc.attach(gizmoProxy);
    highlightCapsule();
  };

  const frameSelected = () => {
    const item = items[sel];
    const p = new THREE.Vector3();
    item.holder.getWorldPosition(p);
    controls.target.set(p.x, item.def.size * 0.45, p.z);
    camera.position.set(p.x + item.def.size * 1.6, item.def.size * 0.9, p.z + item.def.size * 1.9);
  };

  const select = (i, opts = {}) => {
    sel = i;
    if (opts.cap !== undefined) selCap = opts.cap;
    selCap = Math.min(selCap, items[sel].caps.length - 1);
    for (let k = 0; k < items.length; k++) {
      items[k].capMat.opacity = k === sel ? 0.8 : 0.3;
    }
    if (opts.frame !== false) frameSelected();
    rebuildCapGui();
    attachGizmo();
  };
  let guiSquelch = false; // setValue() refires onChange; squelch programmatic sets
  const syncDropdown = idx => {
    guiSquelch = true;
    gui.controllers.find(c => c.property === 'm')?.setValue(idx);
    guiSquelch = false;
  };

  const rebuildCapGui = () => {
    if (capFolder) capFolder.destroy();
    capFolder = gui.addFolder(`capsules: ${items[sel].def.slug}`);
    const item = items[sel];
    const colObj = { c: '#' + new THREE.Color(...item.color).getHexString() };
    capFolder.addColor(colObj, 'c').name('blob albedo').onChange(v => {
      const c = new THREE.Color(v);
      item.color = [c.r, c.g, c.b];
      item.capMat.color.copy(c);
    });
    capFolder.add(item, 'meshVisible').name('show mesh').onChange(v => {
      item.inner.visible = v; // helpers live outside the gltf subgroup
    });
    // gizmo mode row (also keys: W translate / E rotate / R scale)
    const modes = {
      'translate (W)': () => tc.setMode('translate'),
      'rotate (E)': () => tc.setMode('rotate'),
      'scale (R)': () => tc.setMode('scale'),
    };
    for (const [n, fn] of Object.entries(modes)) capFolder.add({ [n]: fn }, n);
    item.caps.forEach((c, i) => {
      const f = capFolder.addFolder(`capsule ${i}`);
      const sync = () => { poseHelpers(item); if (i === selCap) capsuleToProxy(); };
      const bind = (vec, axis, label) => f.add(vec, axis).name(label).step(0.01)
        .listen().onChange(sync);
      bind(c.a, 'x', 'ax'); bind(c.a, 'y', 'ay'); bind(c.a, 'z', 'az');
      bind(c.b, 'x', 'bx'); bind(c.b, 'y', 'by'); bind(c.b, 'z', 'bz');
      f.add(c, 'r', 0.02, 1.6, 0.01).listen().onChange(sync);
      f.add({ sel: () => select(sel, { cap: i, frame: false }) }, 'sel').name('select (gizmo)');
      if (i !== selCap) f.close();
    });
    capFolder.add({ add: () => {
      if (item.caps.length >= MAX_SPH_PER_PROP) return;
      const last = item.caps[item.caps.length - 1];
      item.caps.push({ a: last.a.clone(), b: last.b.clone().add(new THREE.Vector3(0, 0.1, 0)), r: last.r });
      poseHelpers(item);
      select(sel, { cap: item.caps.length - 1, frame: false });
    } }, 'add').name('+ capsule (dup last)');
    capFolder.add({ del: () => {
      if (item.caps.length > 1) {
        item.caps.splice(selCap, 1);
        poseHelpers(item);
        select(sel, { cap: Math.max(0, selCap - 1), frame: false });
      }
    } }, 'del').name('- selected capsule');
  };

  gui.add({ m: 0 }, 'm', Object.fromEntries(items.map((it, i) => [`${it.kind === 'statics' ? 'statue' : 'prop'}: ${it.def.slug}`, i])))
    .name('model').onChange(v => { if (!guiSquelch) select(v); });
  gui.add({ dump: () => {
    const rnd = x => Math.round(x * 1000) / 1000;
    const out = { statics: {}, props: {} };
    for (const item of items) {
      out[item.kind][item.def.slug] = {
        color: item.color.map(rnd),
        capsules: item.caps.map(c => [
          [rnd(c.a.x), rnd(c.a.y), rnd(c.a.z)],
          [rnd(c.b.x), rnd(c.b.y), rnd(c.b.z)],
          rnd(c.r),
        ]),
      };
    }
    const j = JSON.stringify(out, null, 2);
    console.log('OCCLUDER_PROXIES =', j);
    if (navigator.clipboard) navigator.clipboard.writeText(j).catch(() => {});
    alert('proxies JSON copied to clipboard (and console)');
  } }, 'dump').name('DUMP proxies.js JSON');

  // click to select: capsules first (any item's), then whole models
  const ray = new THREE.Raycaster();
  renderer.domElement.addEventListener('pointerdown', ev => {
    if (ev.button !== 0 || tc.dragging) return;
    const ndc = new THREE.Vector2(
      (ev.clientX / innerWidth) * 2 - 1, -(ev.clientY / innerHeight) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const isGizmo = o => { let n = o; while (n) { if (n === tc) return true; n = n.parent; } return false; };
    for (const hit of ray.intersectObjects(scene.children, true)) {
      if (isGizmo(hit.object)) return; // let the gizmo own its clicks
      const pick = hit.object.userData.pick;
      if (pick) { // capsule hit
        select(pick.itemIdx, { cap: pick.capIdx, frame: false });
        syncDropdown(pick.itemIdx);
        return;
      }
      const idx = items.findIndex(it => {
        let n = hit.object;
        while (n) { if (n === it.holder) return true; n = n.parent; }
        return false;
      });
      if (idx >= 0) {
        select(idx, { frame: false });
        syncDropdown(idx);
        return;
      }
    }
  });
  addEventListener('keydown', ev => {
    if (ev.key === 'w' || ev.key === 'W') tc.setMode('translate');
    if (ev.key === 'e' || ev.key === 'E') tc.setMode('rotate');
    if (ev.key === 'r' || ev.key === 'R') tc.setMode('scale');
  });

  select(0);
  renderer.setAnimationLoop(() => {
    controls.update();
    renderer.render(scene, camera);
  });
  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });
  console.log(`proxyedit ready: ${items.length} models`);
}
