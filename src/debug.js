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

export function buildGUI(matsys, state, wires, onRebake, onRelight, culler, reflections, onStaticImposters) {
  const gui = new GUI({ title: 'PortalGI' });
  const g = matsys.globals;
  const proxy = {
    get steps() { return g.uMaxSteps.value; }, set steps(v) { g.uMaxSteps.value = v; },
    get edgeBlend() { return g.uBlendOn.value > 0.5; }, set edgeBlend(v) { g.uBlendOn.value = v ? 1 : 0; },
    get blendBase() { return g.uBlendBase.value; }, set blendBase(v) { g.uBlendBase.value = v; },
    get blendRough() { return g.uBlendRough.value; }, set blendRough(v) { g.uBlendRough.value = v; },
    get distRough() { return g.uDistRough.value; }, set distRough(v) { g.uDistRough.value = v; },
    get irrBlend() { return g.uIrrBlend.value; }, set irrBlend(v) { g.uIrrBlend.value = v; },
    get exposure() { return Math.log2(g.uExposure.value); }, set exposure(v) { g.uExposure.value = Math.pow(2, v); },
    get view() { return g.uDebugMode.value; }, set view(v) { g.uDebugMode.value = v; },
    get portals() { return wires.visible; }, set portals(v) { wires.visible = v; },
    get lightmap() { return g.uUseLightmap.value > 0.5; }, set lightmap(v) { g.uUseLightmap.value = v ? 1 : 0; },
  };
  const f1 = gui.addFolder('Traversal');
  f1.add(proxy, 'steps', 0, 6, 1).name('portal hops (0=PCCM)');
  f1.add(proxy, 'edgeBlend').name('edge blend');
  f1.add(proxy, 'blendBase', 0, 0.4, 0.01).name('blend width base');
  f1.add(proxy, 'blendRough', 0, 3, 0.05).name('blend - rough-dist');
  f1.add(proxy, 'distRough', 0, 1, 0.01).name('rough growth /m');
  f1.add(proxy, 'irrBlend', 0, 6, 0.05).name('irr portal blend (m)');
  const f2 = gui.addFolder('Display');
  f2.add(proxy, 'exposure', -5, 2, 0.1).name('exposure (EV)');
  f2.add(proxy, 'view', { None: 0, 'Cell tint': 1, 'Step heatmap': 2, 'Irradiance only': 3, 'White world': 4, Lightmap: 5 });
  f2.add(proxy, 'portals').name('show portals');
  if (culler) f2.add(culler, 'enabled').name('portal culling');
  if (reflections) f2.add(reflections, 'enabled').name('prop reflections');
  if (onStaticImposters) f2.add({ si: false }, 'si').name('static imposters (rebakes)').onChange(onStaticImposters);
  if (reflections) {
    const fs = gui.addFolder('Smudges');
    const P = reflections.params;
    const refit = () => reflections.refit();
    fs.add(P, 'opacity', 0, 2.5, 0.01);
    fs.add(P, 'feather', 0.02, 1.5, 0.01).name('edge feather');
    fs.add(P, 'fadeBase', 0.02, 0.6, 0.005).name('depth fade (x depth)');
    fs.add(P, 'fadeRough', 0, 1, 0.005).name('fade + per gloss');
    fs.add(P, 'fresnelMin', 0, 1, 0.01).name('fresnel floor');
    fs.add(P, 'breakBase', 0, 2, 0.01).name('breakup base');
    fs.add(P, 'breakSlope', 0, 3, 0.01).name('breakup x rough');
    fs.add(P, 'widenBase', 0, 1, 0.01).name('deep widen');
    fs.add(P, 'widenRough', 0, 2, 0.01).name('widen x rough');
    fs.add(P, 'liftFade', 0.05, 1, 0.01).name('lift fade (m)');
    fs.add(P, 'tintGain', 0, 3, 0.01).name('tint gain');
    fs.add(P, 'fitContactBand', 0.05, 0.6, 0.01).name('fit: contact band').onChange(refit);
    fs.add(P, 'fitWidestLo', 0, 1, 0.01).name('fit: widest lo').onChange(refit);
    fs.add(P, 'fitWidestHi', 0, 1, 0.01).name('fit: widest hi').onChange(refit);
    fs.add(P, 'fitHFrac', 0.1, 1, 0.01).name('fit: height frac').onChange(refit);
    fs.add(P, 'fitAxisScale', 0.3, 1.2, 0.01).name('fit: axis scale').onChange(refit);
    fs.add(P, 'manualScale', 0.4, 2, 0.01).name('furniture: radius x').onChange(refit);
    fs.add(P, 'manualTaper', 1, 2.5, 0.01).name('furniture: taper').onChange(refit);
    fs.add(P, 'manualH', 0.1, 2, 0.01).name('furniture: depth (m)').onChange(refit);
    fs.add({ dump: () => reflections.dumpParams() }, 'dump').name('DUMP values (console+clipboard)');
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
