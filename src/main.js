// PortalGI POC entry point.
// Boot order: manifest probe (baked artifacts?) -> level/hull -> baker ->
// materials -> meshes/props/player -> lighting (load baked OR path-trace +
// capture) -> loop. `?bake=1` runs a high-quality bake and PUTs the textures
// to the dev server under baked/ for distribution.
import * as THREE from 'three';
import { buildTextures, loadPaintingTextures } from './textures.js';
import { buildLevel, packLightmapCharts } from './level.js';
import { buildHullTexture } from './hulldata.js';
import { Baker } from './bake.js';
import { Lightmapper } from './lightmap.js';
import { createMaterialSystem, buildStaticMeshes } from './materials.js';
import { Player } from './player.js';
import { Props } from './props.js';
import { buildGUI, buildPortalWires } from './debug.js';
import { fetchManifest, loadHalfTexture, saveBaked } from './bakedio.js';
import { loadModelProps, addStaticModels } from './models.js';
import { findCell } from './level.js';
import { VRButton } from '../libs/webxr-VRButton.js';

const params = new URLSearchParams(location.search);
const SHOT = params.get('shot') ? parseInt(params.get('shot')) : 0;
const BAKE = params.has('bake');

const SHOT_POSES = {
  1: { pos: [-4.4, 1.6, 2.8], look: [1.5, 0.9, -0.5] },   // gallery: props + gloss floor
  2: { pos: [1.5, 1.3, 0.2], look: [6.3, 0.6, 0] },       // gallery floor reflecting the pillar hall
  3: { pos: [0, 1.7, 10.4], look: [0, 1.6, 14] },          // rotunda marble + emissive ring
  4: { pos: [7.2, 1.7, 3.4], look: [11.3, 0.9, 0] },       // pillar hall: cuts on glossy floor
  5: { pos: [2.5, 1.5, 3.0], look: [2.5, 1.22, 1.4] },     // glass sphere closeup
  6: { pos: [9.6, 1.7, -7.4], look: [14.5, 0.1, -13.8] },  // L-room: floor across the virtual portal
  7: { pos: [1.2, 1.5, 0.8], look: [1.2, 1.35, -1.2] },    // debug pane held up mid-room
  8: { pos: [13.3, 1.6, -18.7], look: [16.4, 0.6, -23.0] },// darkroom: colored corner lamp
  9: { pos: [0, 1.7, 19.2], look: [-0.9, 1.2, 23.5] },     // exhibit hall A: PBR models
  10: { pos: [4.4, 1.7, 22.5], look: [7.5, 1.2, 22.5] },   // cornell box
  11: { pos: [-4.4, 1.6, 22.5], look: [-8.5, 1.1, 22.5] }, // exhibit hall B
};

const overlay = document.getElementById('overlay');
const overlayMsg = document.getElementById('overlay-msg');
const overlaySub = document.getElementById('overlay-sub');
const fpsEl = document.getElementById('fps');
const errEl = document.getElementById('err');

function fail(msg) {
  overlayMsg.textContent = msg;
  overlaySub.textContent = '';
  throw new Error(msg);
}

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: SHOT > 0 });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
document.body.appendChild(renderer.domElement);
if (!renderer.capabilities.isWebGL2) fail('WebGL2 is required.');
if (!renderer.extensions.get('EXT_color_buffer_float')) fail('EXT_color_buffer_float is required (HDR render targets).');
renderer.domElement.addEventListener('webglcontextlost', () => {
  errEl.textContent += 'WEBGL CONTEXT LOST\n';
});

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(SHOT ? 70 : 75, innerWidth / innerHeight, 0.05, 120);
camera.layers.enable(3); // dynamic props live on layer 3 (hidden from bake captures; layers 1/2 are three's XR eye layers)
// XR rig: in-VR the headset drives the camera locally; locomotion moves the rig
const rig = new THREE.Group();
rig.add(camera);
scene.add(rig);

boot();

async function boot() {
  if (params.has('mark')) { // headless heartbeat: upload progress/errors for CI polling
    setInterval(() => {
      fetch(`./baked/status-${SHOT}.txt`, {
        method: 'PUT',
        body: `${document.title}\n${overlayMsg.textContent} ${overlaySub.textContent}\n${errEl.textContent}`,
      }).catch(() => {});
    }, 10000);
  }
  // baked artifacts dictate the lightmap packing parameters -- uv2 layout must
  // match the distributed lightmap exactly
  const manifest = (!BAKE && params.get('baked') !== '0') ? await fetchManifest() : null;
  const lmSettings = manifest ? manifest.settings : {
    lmden: parseFloat(params.get('lmden')) || (BAKE ? 32 : 16),
    lmw: parseInt(params.get('lmw')) || (BAKE ? 2048 : 1024),
    lmrays: parseInt(params.get('lmrays')) || (BAKE ? 384 : 64),
    lmit: parseInt(params.get('lmit')) || (BAKE ? 4 : 3),
    lmps: parseInt(params.get('lmps')) || (BAKE ? 32 : 8),
    lmfp: parseInt(params.get('lmfp')) || (BAKE ? 12 : 1),
  };

  const textures = buildTextures();
  const level = buildLevel();
  await addStaticModels(level); // static exhibits join the builders BEFORE chart packing
  packLightmapCharts(level, lmSettings.lmden, lmSettings.lmw);
  const hullTex = buildHullTexture(level.cells);
  const baker = new Baker(renderer, level, hullTex);
  const matsys = createMaterialSystem(level, textures, hullTex, baker.texture);
  const useLightmap = BAKE || params.get('lm') !== '0';
  const lightmapper = useLightmap ? new Lightmapper(renderer, level, textures, {
    rays: lmSettings.lmrays, iterations: lmSettings.lmit,
    panelSamples: lmSettings.lmps, finalPasses: lmSettings.lmfp,
  }) : null;

  // optional URL overrides for comparison screenshots
  if (params.has('steps')) matsys.globals.uMaxSteps.value = parseInt(params.get('steps'));
  if (params.has('blend')) matsys.globals.uBlendOn.value = parseFloat(params.get('blend'));
  if (params.has('debug')) matsys.globals.uDebugMode.value = parseInt(params.get('debug'));
  if (params.has('irr')) matsys.globals.uIrrBlend.value = parseFloat(params.get('irr'));

  const manager = new THREE.LoadingManager();
  const paintingTexs = loadPaintingTextures(manager);
  buildStaticMeshes(scene, level, matsys, textures, paintingTexs);

  overlayMsg.textContent = 'Loading models...';
  const modelProps = await loadModelProps(matsys, manager);

  const player = new Player(level, renderer.domElement, { headless: SHOT > 0 });
  const props = new Props(scene, level, matsys, modelProps);
  const wires = buildPortalWires(scene, level);
  const state = { bounces: useLightmap ? 1 : 3, baking: false };
  buildGUI(matsys, state, wires, () => rebake(), () => relight());

  if (!SHOT && !BAKE) {
    renderer.domElement.addEventListener('mousedown', e => {
      if (!player.locked) return;
      if (e.button === 0) {
        if (props.held) props.throwHeld(player.viewDir, player.vel);
        else { const p = props.aim(player.pos, player.viewDir); if (p) props.grab(p); }
      } else if (e.button === 2) {
        props.dropHeld();
      }
    });
    renderer.domElement.addEventListener('contextmenu', e => e.preventDefault());
    document.addEventListener('keydown', e => {
      if (e.code === 'KeyE' && player.locked) {
        if (props.held) props.dropHeld();
        else { const p = props.aim(player.pos, player.viewDir); if (p) props.grab(p); }
      }
      if (e.code === 'KeyB' && !state.baking) rebake();
      if (e.code === 'KeyL' && !state.baking) relight();
    });
  }

  function rebake() {
    if (state.baking) return Promise.resolve();
    state.baking = true;
    matsys.globals.uAtlas.value = baker.texture; // leave baked artifacts, go live
    const steps = baker.bakeSteps(scene, matsys, state.bounces);
    const total = baker.totalSteps(state.bounces);
    let done = 0;
    overlay.classList.remove('hidden');
    overlayMsg.textContent = 'Baking hull cubemaps...';
    return new Promise(resolve => {
      const tick = () => {
        const budget = (SHOT || BAKE) ? Infinity : 6;
        for (let i = 0; i < budget; i++) {
          if (steps.next().done) {
            state.baking = false;
            overlay.classList.add('hidden');
            resolve();
            return;
          }
          done++;
        }
        overlaySub.textContent = `${done} / ${total}`;
        requestAnimationFrame(tick);
      };
      tick();
    });
  }

  // path-trace the lightmap, then rebuild the cubemap cache from it
  function relight() {
    if (!lightmapper || state.baking) return Promise.resolve();
    state.baking = true;
    overlay.classList.remove('hidden');
    overlayMsg.textContent = 'Path tracing lightmap...';
    const steps = lightmapper.bakeSteps();
    let done = 0;
    const total = lightmapper.totalSteps();
    return new Promise(resolve => {
      const tick = () => {
        if (steps.next().done) {
          matsys.globals.uLightmap.value = lightmapper.texture;
          matsys.globals.uUseLightmap.value = 1.0;
          state.baking = false;
          resolve(rebake());
          return;
        }
        overlaySub.textContent = `${++done} / ${total}`;
        requestAnimationFrame(tick);
      };
      tick();
    });
  }

  overlayMsg.textContent = 'Loading paintings...';
  await new Promise((res) => {
    manager.onLoad = res;
    manager.onError = url => { errEl.textContent += 'load failed: ' + url + '\n'; };
    setTimeout(res, 8000); // don't hang forever if a texture is missing
  });

  // fast path: distributed baked textures -- no baking at all
  let usedBaked = false;
  if (manifest) {
    try {
      if (manifest.atlas.w !== baker.atlasA.width || manifest.atlas.h !== baker.atlasA.height ||
          manifest.lightmap.w !== level.lightmapSize[0] || manifest.lightmap.h !== level.lightmapSize[1]) {
        throw new Error('baked artifact dimensions do not match the current level -- rebake with ?bake=1');
      }
      overlayMsg.textContent = 'Loading baked lighting...';
      const [atlasTex, lmTex] = await Promise.all([
        loadHalfTexture('./baked/atlas.bin', manifest.atlas.w, manifest.atlas.h),
        loadHalfTexture('./baked/lightmap.bin', manifest.lightmap.w, manifest.lightmap.h),
      ]);
      matsys.globals.uAtlas.value = atlasTex;
      matsys.globals.uLightmap.value = lmTex;
      matsys.globals.uUseLightmap.value = 1.0;
      usedBaked = true;
    } catch (e) {
      errEl.textContent += `baked load failed (${e.message}); baking live\n`;
    }
  }
  if (!usedBaked) {
    if (lightmapper) await relight();
    else await rebake();
  }

  if (BAKE) {
    overlay.classList.remove('hidden');
    overlayMsg.textContent = 'Saving offline bake...';
    overlaySub.textContent = '';
    try {
      const mb = await saveBaked(renderer, baker.atlasA, lightmapper.lmA, lmSettings);
      overlayMsg.textContent = `Offline bake saved (${mb.toFixed(1)} MB) -- reloading`;
      document.title = 'BAKE_SAVED';
      setTimeout(() => { location.href = location.pathname; }, 1500);
    } catch (e) {
      overlayMsg.textContent = 'Bake save failed';
      errEl.textContent += e.message + '\n';
    }
    return;
  }

  if (SHOT) {
    const pose = SHOT_POSES[SHOT] || SHOT_POSES[1];
    camera.position.set(...pose.pos);
    camera.lookAt(...pose.look);
    if (SHOT === 7) { // pose the debug pane as if held up in front of the camera
      const pane = props.list.find(p => p.debugPane);
      pane.mesh.position.set(1.2, 1.35, -1.2);
      pane.mesh.lookAt(camera.position);
    }
    props.update(0.016, player);
    renderer.setRenderTarget(null);
    renderer.render(scene, camera);
    const gl = renderer.getContext();
    const px = new Uint8Array(4);
    gl.readPixels(gl.drawingBufferWidth >> 1, gl.drawingBufferHeight >> 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    errEl.textContent +=
      `shot ${SHOT}${usedBaked ? ' (baked)' : ''}: ${renderer.info.render.calls} calls, ${renderer.info.render.triangles} tris, center px ${px.join(',')}\n`;
    window.__shotReady = true;
    document.title = 'SHOT_READY';
    overlay.classList.add('hidden');
    if (params.has('mark')) { // self-upload the screenshot: robust headless verification
      renderer.domElement.toBlob(b => {
        fetch(`./baked/shot-${SHOT}.png`, { method: 'PUT', body: b }).catch(() => {});
      }, 'image/png');
    }
    (function shotLoop() {
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
      requestAnimationFrame(shotLoop);
    })();
    return;
  }

  overlay.classList.add('hidden');

  // ---- WebXR (Quest): VR button, controller grab, stick locomotion
  let xrCarrier = null; // {pos, viewDir, vel} driving the held prop in VR
  const tmpV = new THREE.Vector3(), tmpQ = new THREE.Quaternion(), headPos = new THREE.Vector3();
  const ctrlCarrier = c => {
    c.getWorldPosition(tmpV);
    c.getWorldQuaternion(tmpQ);
    return {
      pos: tmpV.clone(),
      viewDir: new THREE.Vector3(0, 0, -1).applyQuaternion(tmpQ),
      vel: new THREE.Vector3(),
    };
  };
  if (!navigator.xr) errEl.textContent += 'XR: navigator.xr missing (no WebXR in this browser)\n';
  if (navigator.xr && !SHOT && !BAKE) {
    renderer.xr.enabled = true;
    renderer.xr.setFoveation(1.0);
    document.body.appendChild(VRButton.createButton(renderer));
    navigator.xr.isSessionSupported('immersive-vr')
      .then(ok => { errEl.textContent += `XR: api ok, immersive-vr ${ok ? 'supported' : 'NOT SUPPORTED'}\n`; })
      .catch(e => { errEl.textContent += `XR: isSessionSupported threw: ${e.message || e}\n`; });
    renderer.xr.addEventListener('sessionstart', () => { errEl.textContent += 'XR: session started\n'; });
    renderer.xr.addEventListener('sessionend', () => { // desktop camera owns the rig again
      errEl.textContent += 'XR: session ended\n';
      rig.position.set(0, 0, 0);
      rig.rotation.set(0, 0, 0);
    });
    for (const i of [0, 1]) {
      const c = renderer.xr.getController(i);
      rig.add(c);
      c.addEventListener('selectstart', () => {
        const car = ctrlCarrier(c);
        const p = props.aim(car.pos, car.viewDir, 3.0);
        if (p) { props.grab(p); c.userData.holding = true; }
      });
      c.addEventListener('selectend', () => {
        if (c.userData.holding) { props.dropHeld(); c.userData.holding = false; }
      });
    }
  }
  let snapReady = true;
  function xrUpdate(dt) {
    camera.getWorldPosition(headPos);
    const session = renderer.xr.getSession();
    const heading = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.getWorldQuaternion(tmpQ));
    heading.y = 0;
    heading.normalize();
    const right = new THREE.Vector3(-heading.z, 0, heading.x);
    for (const src of session.inputSources) {
      const a = src.gamepad && src.gamepad.axes;
      if (!a || a.length < 4) continue;
      const x = a[2], y = a[3];
      if (src.handedness === 'left' && (Math.abs(x) > 0.15 || Math.abs(y) > 0.15)) {
        rig.position.addScaledVector(heading, -y * 2.5 * dt);
        rig.position.addScaledVector(right, x * 2.5 * dt);
      }
      if (src.handedness === 'right') {
        if (Math.abs(x) > 0.7 && snapReady) {
          snapReady = false;
          const ang = x > 0 ? -Math.PI / 6 : Math.PI / 6;
          const pivot = new THREE.Vector3(headPos.x, rig.position.y, headPos.z);
          const off = rig.position.clone().sub(pivot);
          off.applyAxisAngle(new THREE.Vector3(0, 1, 0), ang);
          rig.position.copy(pivot).add(off);
          rig.rotateY(ang);
        }
        if (Math.abs(x) < 0.3) snapReady = true;
      }
    }
    // hull collision on the head position; apply the correction to the rig
    camera.getWorldPosition(headPos);
    player.pos.set(headPos.x, 1.7, headPos.z);
    player.cell = findCell(level.cells, player.pos, player.cell);
    player.collide(level.colliders);
    rig.position.x += player.pos.x - headPos.x;
    rig.position.z += player.pos.z - headPos.z;
    const holder = [0, 1].map(i => renderer.xr.getController(i)).find(c => c.userData.holding);
    xrCarrier = holder ? ctrlCarrier(holder)
      : { pos: player.pos, viewDir: heading, vel: new THREE.Vector3() };
  }

  let last = performance.now(), fpsAvg = 0;
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    const inXR = renderer.xr.isPresenting;
    if (!state.baking) {
      if (inXR) {
        try {
          xrUpdate(dt);
          props.update(dt, xrCarrier);
        } catch (e) { // surface XR-path crashes on the page (visible after exit)
          errEl.textContent += `XR loop error: ${e.message}\n`;
        }
      } else {
        player.update(dt, level.colliders);
        props.update(dt, player);
      }
    }
    if (!inXR) {
      player.applyToCamera(camera);
      const aimed = !props.held && props.aim(player.pos, player.viewDir);
      document.getElementById('crosshair').classList.toggle('grab', !!(aimed || props.held));
      renderer.setRenderTarget(null); // a mid-frame bake step may have left an RT bound
      // NEVER do this while presenting: the XR manager binds the headset
      // framebuffer before each frame; resetting to null draws to the hidden
      // canvas and the headset shows black
    }
    renderer.render(scene, camera);
    fpsAvg = fpsAvg * 0.95 + (1 / Math.max(dt, 1e-4)) * 0.05;
    fpsEl.textContent = `${fpsAvg.toFixed(0)} fps * cell: ${level.cells[player.cell].name}${usedBaked ? ' * baked' : ''}`;
  });

  addEventListener('resize', () => {
    if (renderer.xr.isPresenting) return; // entering VR fires a resize; XR owns the size
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });
}
