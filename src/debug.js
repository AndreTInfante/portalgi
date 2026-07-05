// lil-gui panel wired to the shared shader globals + portal wireframe overlay.
import * as THREE from 'three';
import GUI from 'lil-gui';

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

export function buildGUI(matsys, state, wires, onRebake, onRelight, culler, onStaticImposters, perf, audio) {
  const gui = new GUI({ title: 'PortalGI' });
  const g = matsys.globals;
  const proxy = {
    get steps() { return g.uMaxSteps.value; }, set steps(v) { g.uMaxSteps.value = v; },
    get roughHops() { return g.uRoughHops.value > 0.5; }, set roughHops(v) { g.uRoughHops.value = v ? 1 : 0; },
    get edgeBlend() { return g.uBlendOn.value > 0.5; }, set edgeBlend(v) { g.uBlendOn.value = v ? 1 : 0; },
    get blendBase() { return g.uBlendBase.value; }, set blendBase(v) { g.uBlendBase.value = v; },
    get blendRough() { return g.uBlendRough.value; }, set blendRough(v) { g.uBlendRough.value = v; },
    get distRough() { return g.uDistRough.value; }, set distRough(v) { g.uDistRough.value = v; },
    get irrBlend() { return g.uIrrBlend.value; }, set irrBlend(v) { g.uIrrBlend.value = v; },
    get exposure() { return Math.log2(g.uExposure.value); }, set exposure(v) { g.uExposure.value = Math.pow(2, v); },
    get view() { return g.uDebugMode.value; },
    set view(v) {
      g.uDebugMode.value = v;
      // debug views live in separate programs (step accumulator = register
      // pressure); swapping causes a one-off rebuild hitch, like 'use lightmap'
      if (matsys.setDebugCompiled) matsys.setDebugCompiled(v > 0);
    },
    get portals() { return wires.visible; }, set portals(v) { wires.visible = v; },
    get lightmap() { return g.uUseLightmap.value > 0.5; }, set lightmap(v) { matsys.setUseLightmap(v); },
  };
  const f1 = gui.addFolder('Traversal');
  // floors/props run ONE unrolled hop (hop1); these two only steer the full
  // multi-hop march that survives in glass/chrome/pane (0 = PCCM everywhere)
  f1.add(proxy, 'steps', 0, 6, 1).name('portal hops (glass; 0=PCCM)');
  f1.add(proxy, 'roughHops').name('rough-scaled hops (glass)');
  f1.add(proxy, 'edgeBlend').name('edge blend');
  f1.add(proxy, 'blendBase', 0, 0.4, 0.01).name('blend width base (m)');
  f1.add(proxy, 'blendRough', 0, 3, 0.05).name('blend width / rough-m');
  f1.add(proxy, 'distRough', 0, 2, 0.05).name('rough growth (1=physical)');
  // blendedIrr is compiled into the static program only in lightmap-off
  // fallback mode (shader variants); this dial is inert during normal play
  f1.add(proxy, 'irrBlend', 0, 6, 0.05).name('irr blend (lm-off only)');
  const f2 = gui.addFolder('Display');
  f2.add(proxy, 'exposure', -5, 2, 0.1).name('exposure (EV)');
  f2.add(proxy, 'view', { None: 0, 'Cell tint': 1, 'Step heatmap': 2, 'Irradiance only': 3, 'White world': 4, Lightmap: 5 });
  f2.add(proxy, 'portals').name('show portals');
  if (culler) f2.add(culler, 'enabled').name('portal culling');
  if (typeof window !== 'undefined' && window.__setFbScale) {
    f2.add({ fb: 1.0 }, 'fb', 0.7, 1.2, 0.05).name('eye buffer scale (re-enter VR)')
      .onChange(v => window.__setFbScale(v));
  }
  if (onStaticImposters) f2.add({ si: true }, 'si').name('statues via proxies (rebakes)').onChange(onStaticImposters);
  {
    // occluders now split by receiver: STATICS read the texture-space layer
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
    // range now gates only prop-receiver effects + reflection blobs; the
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
  if (perf) {
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
  const f3 = gui.addFolder('Bake');
  f3.add(proxy, 'lightmap').name('use lightmap');
  f3.add(state, 'bounces', 1, 3, 1);
  if (onRelight) f3.add({ relight: onRelight }, 'relight').name('re-trace lightmap (L)');
  f3.add({ rebake: onRebake }, 'rebake').name('re-bake cubemaps (B)');
  f3.add({ offline: () => { location.search = '?bake=1'; } }, 'offline')
    .name('offline bake - baked/ (slow)');
  return gui;
}
