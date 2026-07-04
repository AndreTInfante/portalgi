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
import { PortalCuller } from './culling.js';
import { PerfHarness } from './perf.js';
import { OccluderSystem } from './occluders.js';

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
  12: { pos: [0, 1.5, 10.6], look: [0, 1.4, 12.4] },       // debug pane held up in the rotunda
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
  if (params.has('rhops')) matsys.globals.uRoughHops.value = parseFloat(params.get('rhops'));
  if (params.has('occd')) matsys.globals.uOccDensity.value = parseFloat(params.get('occd'));
  if (params.has('blend')) matsys.globals.uBlendOn.value = parseFloat(params.get('blend'));
  if (params.has('debug')) matsys.globals.uDebugMode.value = parseInt(params.get('debug'));
  if (params.has('irr')) matsys.globals.uIrrBlend.value = parseFloat(params.get('irr'));

  const manager = new THREE.LoadingManager();
  const paintingTexs = loadPaintingTextures(manager);
  const staticGroup = buildStaticMeshes(scene, level, matsys, textures, paintingTexs);
  const culler = new PortalCuller(level);
  if (params.get('cull') === '0') culler.enabled = false;

  overlayMsg.textContent = 'Loading models...';
  const modelProps = await loadModelProps(matsys, manager);

  const player = new Player(level, renderer.domElement, { headless: SHOT > 0 });
  const props = new Props(scene, level, matsys, modelProps);
  const wires = buildPortalWires(scene, level);
  const staticModelMeshes = staticGroup.children.filter(mm => mm.name.includes(':smodel'));
  // ?si=1: exclude static exhibits from captures before the initial bake
  // (A/B: statues represented by their baked capture vs occluder blob only)
  if (params.get('si') === '1') {
    for (const mm of staticModelMeshes) mm.layers.set(3);
  }
  const onStaticImposters = v => {
    for (const mm of staticModelMeshes) mm.layers.set(v ? 3 : 0);
    rebake();
  };
  // analytic occluders: dynamic props as capsule sets inside the traversal,
  // plus furniture/statues (NOT the hall pillar: it is hull geometry, its
  // reflection is traversed for real)
  const occluders = matsys.occ ? new OccluderSystem(matsys.occ, props) : null;
  if (occluders) {
    const walnutAvg = textures.walnut.map.userData.avg;
    // the walnut material of a cell = the surfaces its furniture pieces
    // approximate (own-group skip); floors/walls carry no group
    const walnutMat = cid => {
      const mm = staticGroup.children.find(m => m.userData.cell === cid && m.name.endsWith(':walnut'));
      return mm ? mm.material : null;
    };
    for (const cc of level.colliders) {
      if (cc.h === undefined) continue; // statics register from their meshes below
      const cellId = findCell(level.cells, new THREE.Vector3(cc.x, 0.5, cc.z));
      const rot = cc.rot || 0;
      const cos = Math.cos(rot), sin = Math.sin(rot);
      const P = (lx, y, lz) => [cc.x + lx * cos - lz * sin, y, cc.z + lx * sin + lz * cos];
      if (cc.rx > cc.rz * 2) {
        // bench: one long seat capsule + two narrow leg capsules
        const rs = cc.rz;
        occluders.addPiece([
          [P(-(cc.rx - rs), cc.h * 0.84, 0), P(cc.rx - rs, cc.h * 0.84, 0), rs],
          [P(-cc.rx * 0.86, 0.16, 0), P(-cc.rx * 0.86, cc.h * 0.6, 0), cc.rz * 0.8],
          [P(cc.rx * 0.86, 0.16, 0), P(cc.rx * 0.86, cc.h * 0.6, 0), cc.rz * 0.8],
        ], cellId, walnutAvg, walnutMat(cellId));
      } else {
        // pedestal: a single stretched vertical capsule (tight - the blob
        // overlays the pedestal's own baked reflection, fat reads as fringe;
        // top ends at h so props resting on it start outside the capsule)
        const r = cc.rx;
        occluders.addPiece([
          [[cc.x, r * 0.9, cc.z], [cc.x, cc.h - r, cc.z], r],
        ], cellId, walnutAvg, walnutMat(cellId));
      }
    }
    for (const mm of staticModelMeshes) {
      occluders.addStatic(mm, mm.userData.cell, [0.42, 0.4, 0.36]);
    }
  }
  if (params.has('occluders')) matsys.globals.uOccOn.value = parseFloat(params.get('occluders'));
  // eye-buffer scale: ~19% fill at 0.9 for near-invisible sharpness loss
  // (Tier 2 item 3; ground-truth ~1.9ms at the gallery worst view).
  // Applies at session START - re-enter VR after changing the GUI slider
  renderer.xr.setFramebufferScaleFactor(
    params.has('fbscale') ? parseFloat(params.get('fbscale')) : 1.0);
  window.__setFbScale = v => renderer.xr.setFramebufferScaleFactor(v);
  const perf = new PerfHarness(scene); // GPU headroom probe (docs/unified-occluders.md)
  perf.attachGpuTimer(renderer); // real GPU ms where the browser exposes timer queries
  const state = { bounces: useLightmap ? 1 : 3, baking: false };
  buildGUI(matsys, state, wires, () => rebake(), () => relight(), culler, onStaticImposters, perf);

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
    // hold-E + mouse rotates the held prop (look is suppressed); a quick tap
    // (<250ms, <6px) keeps tap-to-drop. Rotation persists after release.
    const UP = new THREE.Vector3(0, 1, 0);
    const eRot = { down: false, active: false, t0: 0, moved: 0 };
    document.addEventListener('keydown', e => {
      if (e.code === 'KeyE' && player.locked && !e.repeat) {
        if (props.held) {
          eRot.down = true; eRot.active = false;
          eRot.t0 = performance.now(); eRot.moved = 0;
        } else {
          const p = props.aim(player.pos, player.viewDir);
          if (p) props.grab(p);
        }
      }
      if (e.code === 'KeyB' && !state.baking) rebake();
      if (e.code === 'KeyL' && !state.baking) relight();
    });
    document.addEventListener('keyup', e => {
      if (e.code !== 'KeyE' || !eRot.down) return;
      if (!eRot.active && performance.now() - eRot.t0 < 250) props.dropHeld();
      eRot.down = false; eRot.active = false;
      player.lookLocked = false;
    });
    document.addEventListener('mousemove', e => {
      if (!eRot.down || !player.locked || !props.held) return;
      eRot.moved += Math.abs(e.movementX) + Math.abs(e.movementY);
      if (!eRot.active) {
        // under both thresholds this may still resolve to a tap-to-drop
        if (eRot.moved < 6 && performance.now() - eRot.t0 < 250) return;
        eRot.active = true;
        player.lookLocked = true;
      }
      // camera-relative: yaw about world up, pitch about the camera's right
      const q = new THREE.Quaternion();
      const right = new THREE.Vector3(Math.cos(player.yaw), 0, -Math.sin(player.yaw));
      const held = props.held;
      held.mesh.quaternion.premultiply(q.setFromAxisAngle(UP, -e.movementX * 0.005));
      held.mesh.quaternion.premultiply(q.setFromAxisAngle(right, -e.movementY * 0.005));
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
          matsys.setUseLightmap(true);
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
      matsys.setUseLightmap(true);
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
    if (SHOT === 7 || SHOT === 12) { // pose the debug pane as if held up in front of the camera
      const pane = props.list.find(p => p.debugPane);
      if (SHOT === 7) pane.mesh.position.set(1.2, 1.35, -1.2);
      else pane.mesh.position.set(0, 1.4, 12.4);
      pane.mesh.lookAt(camera.position);
    }
    props.update(0.016, player);
    if (occluders) occluders.update();
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
  let xrCarrier = null; // carrier driving the held prop in VR (see props.update)
  const tmpV = new THREE.Vector3(), tmpQ = new THREE.Quaternion(), headPos = new THREE.Vector3();
  // controller world velocity over the last ~120ms of samples: swing throws
  // need more than a single-frame delta
  const ctrlVel = c => {
    const h = c && c.userData.hist;
    if (!h || h.length < 2) return new THREE.Vector3();
    const a = h[0], b = h[h.length - 1];
    const span = b.t - a.t;
    return span > 1e-3 ? b.p.clone().sub(a.p).divideScalar(span) : new THREE.Vector3();
  };
  const ctrlCarrier = c => {
    c.getWorldPosition(tmpV);
    c.getWorldQuaternion(tmpQ);
    return {
      pos: tmpV.clone(),
      quat: tmpQ.clone(),
      viewDir: new THREE.Vector3(0, 0, -1).applyQuaternion(tmpQ),
      vel: ctrlVel(c),
      eye: headPos.clone(),
      mode: 'attach',
    };
  };
  // in-VR frame-rate cap toggle (A/X button on either controller)
  const rateState = { target: 90, ready: true };
  const rateCanvas = document.createElement('canvas');
  rateCanvas.width = 128; rateCanvas.height = 64;
  const rateTex = new THREE.CanvasTexture(rateCanvas);
  const rateLabel = new THREE.Mesh(new THREE.PlaneGeometry(0.08, 0.04),
    new THREE.MeshBasicMaterial({ map: rateTex, transparent: true, depthTest: false }));
  function drawRate() {
    const ctx = rateCanvas.getContext('2d');
    ctx.clearRect(0, 0, 128, 64);
    ctx.fillStyle = '#9fd4ff';
    ctx.font = 'bold 38px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText(rateState.target + 'Hz', 64, 44);
    rateTex.needsUpdate = true;
  }
  drawRate();
  function applyRate(session) {
    if (session && session.updateTargetFrameRate) {
      session.updateTargetFrameRate(rateState.target).catch(() => {});
    }
  }
  if (navigator.xr) renderer.xr.addEventListener('sessionstart', () => applyRate(renderer.xr.getSession()));

  // perf sweep config string: names the A/B condition in every report
  perf.configFn = () =>
    `steps${matsys.globals.uMaxSteps.value}/rh${matsys.globals.uRoughHops.value > 0.5 ? 1 : 0}` +
    `/occ${matsys.globals.uOccOn.value > 0.5 ? 1 : 0}` +
    `/cull${culler.enabled ? 1 : 0}/` +
    (renderer.xr.isPresenting ? `${rateState.target}Hz` : 'desktop');
  if (params.has('burn')) perf.setBurn(parseInt(params.get('burn')));
  if (params.get('sweep') === '1') setTimeout(() => perf.startSweep(perf.configFn()), 3000);
  if (params.get('batch') === '1') setTimeout(() => {
    const b = perf.batchSetup();
    perf.startBatch(b.configs, b.restore);
  }, 3000);
  // one-button config matrix: the combinations we actually compare
  perf.batchSetup = () => {
    const g = matsys.globals;
    const saved = {
      steps: g.uMaxSteps.value, rh: g.uRoughHops.value, occ: g.uOccOn.value,
    };
    const set = (steps, rh, occ) => () => {
      g.uMaxSteps.value = steps;
      g.uRoughHops.value = rh;
      g.uOccOn.value = occ;
    };
    return {
      configs: [
        { name: 'occ-off', apply: set(3, 1, 0) },  // baseline first
        { name: 'occluders', apply: set(3, 1, 1) },
        { name: 'flat-hops', apply: set(3, 0, 0) },
        { name: 'steps0', apply: set(0, 1, 0) },
      ],
      restore: () => {
        g.uMaxSteps.value = saved.steps;
        g.uRoughHops.value = saved.rh;
        g.uOccOn.value = saved.occ;
      },
    };
  };
  perf.onBatchDone = report => { errEl.textContent += '\n' + report + '\n'; };
  // in-VR perf readout: wrist label above controller 0, beside the rate label
  const perfCanvas = document.createElement('canvas');
  perfCanvas.width = 512; perfCanvas.height = 224;
  const perfTex = new THREE.CanvasTexture(perfCanvas);
  const perfLabel = new THREE.Mesh(new THREE.PlaneGeometry(0.24, 0.105),
    new THREE.MeshBasicMaterial({ map: perfTex, transparent: true, depthTest: false }));
  let perfLabelText = null;
  function drawPerfLabel() {
    // finished batch: show the full report; otherwise the one-line status
    const report = (!perf.sweep && !perf.batch && perf.batchReport) ? perf.batchReport : '';
    const txt = report || perf.hudText();
    if (txt === perfLabelText) return;
    perfLabelText = txt;
    const ctx = perfCanvas.getContext('2d');
    ctx.clearRect(0, 0, 512, 224);
    ctx.fillStyle = '#c8ffc8';
    if (report) {
      ctx.font = 'bold 22px monospace';
      ctx.textAlign = 'left';
      const lines = report.split('\n');
      for (let i = 0; i < Math.min(lines.length, 9); i++) {
        ctx.fillText(lines[i], 8, 26 + i * 24);
      }
    } else if (txt) {
      ctx.font = 'bold 30px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText(txt, 256, 200);
    }
    perfTex.needsUpdate = true;
  }

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
      for (const j of [0, 1]) { // controllers vanish: drop the prop in place
        const cc = renderer.xr.getController(j);
        if (cc) { cc.userData.holding = false; cc.userData.hist = []; }
      }
      props.dropHeld();
    });
    for (const i of [0, 1]) {
      const c = renderer.xr.getController(i);
      rig.add(c);
      // visible hand: emissive puck + aim laser (layer 3: XR-only, never captured)
      const puck = new THREE.Mesh(new THREE.SphereGeometry(0.035, 16, 12),
        matsys.makeMaterial(0, { tint: [0.02, 0.02, 0.02], emissive: [1.5, 1.6, 1.8] }));
      puck.layers.set(3);
      c.add(puck);
      const laserGeo = new THREE.BufferGeometry().setFromPoints(
        [new THREE.Vector3(), new THREE.Vector3(0, 0, -3)]);
      const laser = new THREE.Line(laserGeo,
        new THREE.LineBasicMaterial({ color: 0x88ccff, transparent: true, opacity: 0.35 }));
      laser.layers.set(3);
      c.add(laser);
      if (i === 0) { // 72/90 target-rate label above the first controller
        rateLabel.position.set(0, 0.055, -0.03);
        rateLabel.rotation.x = -0.7;
        rateLabel.layers.set(3);
        c.add(rateLabel);
        perfLabel.position.set(0, 0.12, 0.02);
        perfLabel.rotation.x = -0.7;
        perfLabel.layers.set(3);
        c.add(perfLabel);
      }
      c.addEventListener('selectstart', () => {
        const car = ctrlCarrier(c);
        const held = props.held;
        if (held) { // hand-to-hand: take the held prop when this hand is inside it
          if (!c.userData.holding && held.mesh.position.distanceTo(car.pos) < held.radius + 0.06) {
            const other = renderer.xr.getController(1 - i);
            if (other) other.userData.holding = false;
            props.grabAttach(held, car);
            c.userData.holding = true;
          }
          return;
        }
        const near = props.touch(car.pos, 0.06); // hand inside a prop: attach in place
        if (near) { props.grabAttach(near, car); c.userData.holding = true; return; }
        const p = props.aim(car.pos, car.viewDir, 3.0);
        if (p) { props.grabBeam(p, car); c.userData.holding = true; }
      });
      c.addEventListener('selectend', () => {
        if (!c.userData.holding) return;
        c.userData.holding = false;
        props.release(ctrlVel(c));
      });
    }
  }
  let snapReady = true;
  let perfBtnReady = true;
  function xrUpdate(dt) {
    // three's XR eye cameras have their OWN layer masks (0|1 and 0|2) - our
    // dynamic layer 3 must be enabled on them or props vanish in-session
    const xrCam = renderer.xr.getCamera();
    xrCam.layers.enable(3);
    for (const c of xrCam.cameras) c.layers.enable(3);
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
          for (const j of [0, 1]) { // snap turn teleports the hands: stale velocity
            const cc = renderer.xr.getController(j);
            if (cc) cc.userData.hist = [];
          }
        }
        if (Math.abs(x) < 0.3) snapReady = true;
      }
    }
    // A/X button: toggle the target frame-rate cap between 72 and 90
    let ratePressed = false;
    for (const src of session.inputSources) {
      const b = src.gamepad && src.gamepad.buttons;
      if (b && b[4] && b[4].pressed) ratePressed = true;
    }
    if (ratePressed && rateState.ready) {
      rateState.ready = false;
      rateState.target = rateState.target === 90 ? 72 : 90;
      drawRate();
      applyRate(session);
    }
    if (!ratePressed) rateState.ready = true;
    // B/Y button: run/cancel the full perf batch (hold still and keep the
    // view representative while it runs - it measures what you're looking at)
    let perfPressed = false;
    for (const src of session.inputSources) {
      const b = src.gamepad && src.gamepad.buttons;
      if (b && b[5] && b[5].pressed) perfPressed = true;
    }
    if (perfPressed && perfBtnReady) {
      perfBtnReady = false;
      if (perf.batch || perf.sweep) {
        perf.cancelBatch();
      } else {
        const b = perf.batchSetup();
        perf.startBatch(b.configs, b.restore);
      }
    }
    if (!perfPressed) perfBtnReady = true;
    // hull collision on the head position; apply the correction to the rig
    camera.getWorldPosition(headPos);
    player.pos.set(headPos.x, 1.7, headPos.z);
    player.cell = findCell(level.cells, player.pos, player.cell);
    player.collide(level.colliders);
    rig.position.x += player.pos.x - headPos.x;
    rig.position.z += player.pos.z - headPos.z;
    // per-controller position history (post-locomotion) feeds swing-release throws
    const now = performance.now() * 0.001;
    for (const j of [0, 1]) {
      const cc = renderer.xr.getController(j);
      if (!cc) continue;
      cc.getWorldPosition(tmpV);
      const hist = cc.userData.hist || (cc.userData.hist = []);
      hist.push({ p: tmpV.clone(), t: now });
      while (hist.length > 2 && now - hist[0].t > 0.12) hist.shift();
    }
    const holder = [0, 1].map(i => renderer.xr.getController(i)).find(c => c && c.userData.holding);
    xrCarrier = holder ? ctrlCarrier(holder)
      : { pos: player.pos, quat: null, viewDir: heading, vel: new THREE.Vector3(), eye: headPos.clone(), mode: 'ray' };
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
    // portal-frustum culling: only cells reachable through on-screen portals
    // draw (reflections are atlas-based and immune). All-visible during bakes.
    if (culler.enabled && !state.baking) {
      culler.compute(inXR ? renderer.xr.getCamera() : camera, inXR ? headPos : player.pos);
    }
    culler.apply(staticGroup, props, state.baking);
    if (occluders && !state.baking) occluders.update();
    if (!inXR) {
      player.applyToCamera(camera);
      const aimed = !props.held && props.aim(player.pos, player.viewDir);
      document.getElementById('crosshair').classList.toggle('grab', !!(aimed || props.held));
      renderer.setRenderTarget(null); // a mid-frame bake step may have left an RT bound
      // NEVER do this while presenting: the XR manager binds the headset
      // framebuffer before each frame; resetting to null draws to the hidden
      // canvas and the headset shows black
    }
    perf.gpuBegin();
    renderer.render(scene, camera);
    perf.gpuEnd();
    perf.tick(now);
    if (inXR) drawPerfLabel();
    fpsAvg = fpsAvg * 0.95 + (1 / Math.max(dt, 1e-4)) * 0.05;
    const ph = perf.hudText();
    fpsEl.textContent = `${fpsAvg.toFixed(0)} fps * cells ${culler.enabled ? culler.visible.size : 'all'} * ${level.cells[player.cell].name}${usedBaked ? ' * baked' : ''}${ph ? ' * ' + ph : ''}`;
  });

  addEventListener('resize', () => {
    if (renderer.xr.isPresenting) return; // entering VR fires a resize; XR owns the size
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });
}
