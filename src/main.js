// PortalGI POC entry point.
// Boot order: manifest probe (baked artifacts?) -> level/hull -> baker ->
// materials -> meshes/props/player -> lighting (load baked OR path-trace +
// capture) -> loop. `?bake=1` runs a high-quality bake and PUTs the textures
// to the dev server under baked/ for distribution.
import * as THREE from 'three';
import { buildTextures, applyRealTextures, loadPaintingTextures } from './textures.js';
import { buildLevel, packLightmapCharts } from './level.js';
import { buildHullTexture } from './hulldata.js';
import { Baker } from './bake.js';
import { Lightmapper } from './lightmap.js';
import { createMaterialSystem, buildStaticMeshes } from './materials.js';
import { Player } from './player.js';
import { Props } from './props.js';
import { buildGUI, buildPortalWires, buildPhysicsWires } from './debug.js';
import { fetchManifest, loadHalfTexture, saveBaked, saveAtlasOnly } from './bakedio.js';
import { loadModelProps, addStaticModels } from './models.js';
import { findCell } from './level.js';
import { VRButton } from '../libs/webxr-VRButton.js';
import { PortalCuller } from './culling.js';
import { PerfHarness } from './perf.js';
import { OccluderSystem } from './occluders.js';
import { DynOccLayer } from './dynocc.js';
import { buildWarpField } from './warpfield.js';
import { buildLightVisTexture } from './lightvis.js';
import { VRMenu } from './vrmenu.js';
import { AudioSystem } from './audio.js';
import { TouchControls, isTouchDevice } from './touch.js';
import { PhysicsWorld } from './physics.js';

const params = new URLSearchParams(location.search);
const SHOT = params.get('shot') ? parseInt(params.get('shot')) : 0;
const BAKE = params.has('bake');
// the offline bake PUTs its artifacts back to serve.mjs - it can only work
// from the local dev server. Fail FAST (before minutes of path tracing)
// instead of dying on the save with an opaque 'failed to fetch'.
if (BAKE && !['127.0.0.1', 'localhost'].includes(location.hostname)) {
  document.getElementById('overlay-msg').textContent =
    'Offline bake needs the local dev server (serve.mjs) - open http://127.0.0.1:8123/?bake=1';
  throw new Error('bake on non-local origin');
}

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
  // seam-artifact investigation close-ups (cell-boundary seams)
  13: { pos: [10.6, 1.5, -9.4], look: [12.3, 1.2, -11.6] }, // L-bend convex corner
  14: { pos: [14.3, 1.7, -8.8], look: [14.3, 0.0, -12.6] }, // L1/L2 floor seam (virtual portal)
  15: { pos: [0, 1.6, 2.4], look: [0, -0.2, 4.3] },         // gallery->corridor doorway floor strip
  // lighting-variety rooms
  16: { pos: [13.2, 1.6, 0], look: [17.5, 1.3, 0] },        // pillar hall -> courtyard door (sun pool)
  17: { pos: [17.4, 1.6, -1.8], look: [21.5, 2.6, 1.6] },   // inside the courtyard (sky + sun)
  18: { pos: [-4.4, 1.6, 22.5], look: [-8.5, 1.0, 22.5] },  // hall B spot-lit exhibits
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

// Chrome blocklists pages that crashed the GPU process ("context loss and
// was blocked"): three then throws out of the constructor. Catch it and say
// what actually helps instead of dying in the console.
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: SHOT > 0 });
} catch (e) {
  fail('WebGL is unavailable (your browser may have blocked it after an earlier crash). ' +
    'Fully close and reopen the browser, then try again.');
}
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
document.body.appendChild(renderer.domElement);
if (!renderer.capabilities.isWebGL2) fail('WebGL2 is required.');
if (!renderer.extensions.get('EXT_color_buffer_float')) fail('EXT_color_buffer_float is required (HDR render targets).');
let glLost = false;
renderer.domElement.addEventListener('webglcontextlost', () => {
  glLost = true;
  errEl.textContent += 'WEBGL CONTEXT LOST\n';
});

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(SHOT ? 70 : 75, innerWidth / innerHeight, 0.05, 120);
camera.layers.enable(3); // dynamic props live on layer 3 (hidden from bake captures; layers 1/2 are three's XR eye layers)
// XR rig: in-VR the headset drives the camera locally; locomotion moves the rig
const rig = new THREE.Group();
rig.add(camera);
scene.add(rig);

// ?proxyedit=1: standalone occluder-capsule authoring gallery instead of the
// demo (loads every prop/statue model, solid capsule overlays, proxies.js dump)
if (params.get('proxyedit') === '1') {
  document.getElementById('overlay').classList.add('hidden');
  import('./proxyedit.js').then(m => m.startProxyEditor(renderer));
} else {
  boot();
}

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
  // Poly Haven photo sets replace the procedural ones (?realtex=0 to compare);
  // on fetch failure the procedural fallback just stays in place
  if (params.get('realtex') !== '0') {
    overlayMsg.textContent = 'Loading textures...';
    try { await applyRealTextures(textures); }
    catch (e) { console.warn('real textures unavailable, using procedural:', e.message); }
  }
  const level = buildLevel();
  await addStaticModels(level); // static exhibits join the builders BEFORE chart packing
  packLightmapCharts(level, lmSettings.lmden, lmSettings.lmw);
  const hullTex = buildHullTexture(level.cells);
  // portal warp fields: OFF after the in-headset verdict (2026-07-05).
  // The field cannot resolve geometry silhouettes BEYOND the portal (the
  // hall pillar) at feasible angular resolution: behind-pillar reflections
  // wobbled (t lerped across 5.6-degree bins) and hard seams appeared at
  // every bin crossing (the tap-consensus reference id flips where bins
  // disagree). The analytic per-pixel walk is exactly what makes those
  // reflections stable - it stays. ?warp=1 re-enables the experiment.
  const warp = params.get('warp') === '1' ? buildWarpField(renderer, level, hullTex) : null;
  const baker = new Baker(renderer, level, hullTex);
  // ?fp16=0: compile everything highp (A/B for the mediump experiment -
  // desktop ignores mediump entirely, so only the headset can judge it)
  const matsys = createMaterialSystem(level, textures, hullTex, baker.texture,
    // ?texocc=0: statics compile the analytic capsule loops instead of the
    // texture-space occlusion tap (A/B + escape hatch, like fp16).
    // ?hop1=0: floors/props compile the full march instead of the unrolled
    // single hop (A/B; hop1 should be pixel-identical to ?hop1=0&steps=1)
    { fp16: params.get('fp16') !== '0', texOcc: params.get('texocc') !== '0',
      hop1: params.get('hop1') !== '0', warp,
      // ?pvd=0: prop diffuse (probes/AO/shadows) back to per-pixel (A/B)
      pvd: params.get('pvd') !== '0',
      // ?mattespec: 1 = tiered (default: one-hop only on open-plan
      // walls/ceilings that straddle cuts, zero-hop elsewhere),
      // 3 = one-hop on ALL matte (tiering perf A/B), 2 = zero-hop
      // everywhere (seams at cuts), 0 = flat irradiance
      matteSpec: params.has('mattespec') ? (parseInt(params.get('mattespec')) || 0) : 1,
      // ?ceilspec=1 restores satin PCCM ceilings (default: ceilings are
      // HARD diffuse, spec block compiled out - the 90Hz budget trade,
      // walls keep satin; irradiance-tap demotion still seamed at cuts)
      ceilSpec: params.get('ceilspec') === '1',
      // ?occdynprop=999 restores uncapped prop-program dyn casters (A/B)
      occDynProp: params.has('occdynprop') ? parseInt(params.get('occdynprop')) : 4 });
  const useLightmap = BAKE || params.get('lm') !== '0';
  const lightmapper = useLightmap ? new Lightmapper(renderer, level, textures, {
    rays: lmSettings.lmrays, iterations: lmSettings.lmit,
    panelSamples: lmSettings.lmps, finalPasses: lmSettings.lmfp,
  }) : null;
  // per-light probe visibility for prop spot direct (lightvis.js): CPU rays
  // against the lightmapper's BVH at boot. Without it (?lm=0 debug boots)
  // visibility stays all-1 (the pre-vis behavior). ?lvis=0 disables for A/B.
  if (lightmapper && params.get('lvis') !== '0') {
    matsys.globals.uLightVis.value = buildLightVisTexture(level, lightmapper.bvh);
    if (params.get('lvis') === 'black') { // positive control: every prop
      const t = matsys.globals.uLightVis.value; // spot must go dark
      t.image.data.fill(0);
      t.needsUpdate = true;
    }
  }

  // optional URL overrides for comparison screenshots
  if (params.has('steps')) matsys.globals.uMaxSteps.value = parseInt(params.get('steps'));
  if (params.has('rhops')) matsys.globals.uRoughHops.value = parseFloat(params.get('rhops'));
  if (params.has('occd')) matsys.globals.uOccDensity.value = parseFloat(params.get('occd'));
  if (params.has('occlod')) matsys.globals.uOccLod.value = parseFloat(params.get('occlod'));
  if (params.has('distrough')) matsys.globals.uDistRough.value = parseFloat(params.get('distrough'));
  if (params.has('blend')) matsys.globals.uBlendOn.value = parseFloat(params.get('blend'));
  if (params.has('debug')) {
    matsys.globals.uDebugMode.value = parseInt(params.get('debug'));
    matsys.setDebugCompiled(parseInt(params.get('debug')) > 0);
  }
  if (params.has('irr')) matsys.globals.uIrrBlend.value = parseFloat(params.get('irr'));

  const manager = new THREE.LoadingManager();
  const paintingTexs = loadPaintingTextures(manager);
  const staticGroup = buildStaticMeshes(scene, level, matsys, textures, paintingTexs);
  // sky dome (CC0 Poly Haven, tonemapped): pure visual - not a builder, so it
  // is absent from the lightmap bake and BVH, but present in cubemap captures
  // (reflections + traversal exits through the courtyard's open ceiling see
  // it) and in the player's view. Illumination comes from the analytic sun
  // point + the sky NEE panel instead. The material speaks the scene's HDR
  // convention: capture pass (uBake) writes linear radiance at uGain x the
  // LDR jpg (an LDR dome capped reflections at 1.0 - sky read dim vs lit
  // plaster at ~3+), display pass tonemaps with the shared exposure.
  let dome = null;
  {
    const skyTex = new THREE.TextureLoader(manager)
      .load('./assets/textures/sky/kloofendal_48d_partly_cloudy_puresky.jpg');
    skyTex.colorSpace = THREE.SRGBColorSpace;
    dome = new THREE.Mesh(
      new THREE.SphereGeometry(70, 48, 24),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        uniforms: {
          uMap: { value: skyTex },
          uGain: { value: params.has('skygain') ? parseFloat(params.get('skygain')) : 6.0 },
          uExposure: matsys.globals.uExposure, // shared identity with the scene
          uBake: matsys.globals.uBake,
        },
        vertexShader: /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: /* glsl */`
varying vec2 vUv;
uniform sampler2D uMap;
uniform float uGain, uExposure, uBake;
vec3 aces(vec3 x) { return clamp(x * (2.51 * x + 0.03) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
void main() {
  vec3 c = texture2D(uMap, vUv).rgb * uGain; // approx HDR re-expansion of the LDR sky
  gl_FragColor = uBake > 0.5 ? vec4(c, 1.0)
    : vec4(pow(aces(c * uExposure), vec3(1.0 / 2.2)), 1.0);
}`,
      }));
    dome.position.set(19.6, 0, 0); // centered on the courtyard
    // 0.0 aligns the HDRI's sun (u = 0.601 in the equirect, measured) with
    // the analytic sun's azimuth: az = pi - 2*pi*u + rot for three's sphere
    // UV mapping, solved for atan2(-10, 13.4). ?skyrot= still overrides.
    dome.rotation.y = params.has('skyrot') ? parseFloat(params.get('skyrot')) : 0.0;
    scene.add(dome);
  }
  const culler = new PortalCuller(level);
  if (params.get('cull') === '0') culler.enabled = false;

  overlayMsg.textContent = 'Loading models...';
  const modelProps = await loadModelProps(matsys, manager);

  const player = new Player(level, renderer.domElement, { headless: SHOT > 0 });
  const physics = new PhysicsWorld(level); // cannon-es: props vs level/furniture/each other
  const props = new Props(scene, level, matsys, modelProps, physics);
  // collision-shape wireframes (Display > 'show collision shapes'): built
  // AFTER Props so every prop body exists. Ground truth for contact bugs -
  // statue sphere bands and prop hulls both diverge from the visual mesh.
  const physWires = buildPhysicsWires(physics.world);
  if (params.get('physwires') === '1') physWires.group.visible = true;
  scene.add(physWires.group);
  const audio = new AudioSystem();
  props.onImpact = (pos, speed, p) => audio.impact(pos, speed, p.radius);
  if (!SHOT && !BAKE) {
    // AudioContext needs a user gesture; every route into the demo passes one
    document.addEventListener('pointerdown', () => audio.unlock());
    document.addEventListener('keydown', () => audio.unlock());
    renderer.xr.addEventListener('sessionstart', () => audio.unlock());
    // one-click mute next to the GUI panel (persists via localStorage)
    const muteEl = document.getElementById('mute');
    const drawMute = () => { muteEl.textContent = audio.muted ? '\u{1F507}' : '\u{1F50A}'; };
    muteEl.classList.remove('hidden');
    drawMute();
    muteEl.addEventListener('click', () => { audio.muted = !audio.muted; drawMute(); });
    document.getElementById('about').classList.remove('hidden');
    // phones/tablets: floating joystick + swipe-look + tap-to-grab. The
    // desktop mousedown/keyboard handlers all gate on pointer lock, which
    // never engages on touch, so the two schemes don't fight
    if (isTouchDevice()) new TouchControls(player, props, camera, renderer.domElement);
  }
  const wires = buildPortalWires(scene, level);
  const staticModelMeshes = staticGroup.children.filter(mm => mm.name.includes(':smodel'));
  // everything with capsule proxies (statues AND furniture) is OUT of the
  // cubemap captures by default: one representation per object (capsules in
  // reflections, capsule AO in diffuse, lightmap receive-only).
  // ?si=0 re-includes them for A/B.
  const proxiedStaticMeshes = staticGroup.children.filter(
    mm => mm.name.includes(':smodel') || mm.name.endsWith(':furniture'));
  if (params.get('si') !== '0') {
    for (const mm of proxiedStaticMeshes) mm.layers.set(3);
  }
  const onStaticImposters = v => {
    for (const mm of proxiedStaticMeshes) mm.layers.set(v ? 3 : 0);
    rebake();
  };
  // analytic occluders: dynamic props as capsule sets inside the traversal,
  // plus furniture/statues (NOT the hall pillar: it is hull geometry, its
  // reflection is traversed for real)
  const occluders = matsys.occ ? new OccluderSystem(matsys.occ, props, level) : null;
  if (occluders) {
    const walnutAvg = textures.walnut.map.userData.avg;
    // the furniture material of a cell = the surfaces its capsule pieces
    // approximate (own-group skip); floors/walls carry no group
    const walnutMat = cid => {
      const mm = staticGroup.children.find(m => m.userData.cell === cid && m.name.endsWith(':furniture'));
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
        // pedestal: a single stretched vertical capsule (top ends at h so
        // props resting on it start outside). Radius x1.2 (Andre 2026-07-04:
        // x1.1, tight fit read too thin in reflections; +10% 2026-07-06).
        // Bottom sphere center sunk BELOW the floor: the hemispherical cap
        // used to taper right at ground level (~0.44r wide at y=0), leaving
        // the contact shadow/AO detached from the base (peter panning) -
        // clipped in, the full-width cross-section lines up with the base.
        const r = cc.rx * 1.2;
        occluders.addPiece([
          [[cc.x, -0.08, cc.z], [cc.x, cc.h - r, cc.z], r],
        ], cellId, walnutAvg, walnutMat(cellId));
      }
    }
    for (const mm of staticModelMeshes) {
      occluders.addStatic(mm, mm.userData.cell, [0.42, 0.4, 0.36]);
    }
  }
  // texture-space occlusion layer (dynocc.js): statics splat their AO once
  // (constructed here, AFTER every static occluder group id is assigned);
  // props re-splat per frame - but only when one actually moved. The dials
  // stay live for the dyn layer; base-layer dial changes need a reload.
  // layer density divisor vs the lightmap: half-res verified fine on Quest
  // (Andre 2026-07-05) - Quest/mobile take 2, PC takes FULL res (1).
  // ?dynres= overrides for A/B.
  const dynDiv = params.has('dynres') ? parseInt(params.get('dynres'))
    : (navigator.userAgent.includes('OculusBrowser') || isTouchDevice()) ? 2 : 1;
  // splat penumbra floor ~ 1.5 LAYER texels (scales with the divisor):
  // shadows narrower than a texel dim out instead of aliasing.
  // ?pensoft= overrides (meters; 0 = the old hard-edged splat).
  const penSoft = params.has('pensoft')
    ? parseFloat(params.get('pensoft')) : 1.5 * dynDiv / lmSettings.lmden;
  const occDialsObj = { ao: 0, aoClamp: 0, shadow: 0, penSoft };
  const occDials = () => {
    occDialsObj.ao = matsys.globals.uOccAO.value;
    occDialsObj.aoClamp = matsys.globals.uOccAOClamp.value;
    occDialsObj.shadow = matsys.globals.uOccShadow.value;
    return occDialsObj;
  };
  let dynOcc = null;
  if (occluders && matsys.texOcc) {
    dynOcc = new DynOccLayer(renderer, level, staticGroup, dynDiv);
    dynOcc.bakeBase(occluders.statics, occDials());
    matsys.globals.uDynOcc.value = dynOcc.texture;
  }
  // agent C: ONE shadow direction per CASTER - the luminance/d2-weighted
  // average of its cell's lights AT the prop (the same weighting the shader's
  // capsuleShadow ran per receiver pixel). Following the caster instead of
  // the receiver's cell also removes the direction snap at portal crossings.
  const _sdAcc = new THREE.Vector3(), _sdL = new THREE.Vector3(), _sdAxis = new THREE.Vector3();
  const _sdRaw = new THREE.Vector4();
  const shadowDirFor = (e, alpha) => {
    const pos = e.p.mesh.position;
    const lights = level.cells[e.p.cell].lights;
    _sdAcc.set(0, 0, 0);
    let wsum = 0;
    for (let i = 0; i < Math.min(lights.length, 8); i++) {
      const l = lights[i];
      _sdL.set(l.pos[0] - pos.x, l.pos[1] - pos.y, l.pos[2] - pos.z);
      const d2 = Math.max(_sdL.lengthSq(), 0.25);
      let w = (0.299 * l.color[0] + 0.587 * l.color[1] + 0.114 * l.color[2]) * l.intensity / d2;
      if (l.dir) { // spot falloff at the caster (soft 0.08-cos shoulder)
        const cosO = Math.cos((l.cone || 35) * Math.PI / 180);
        _sdAxis.set(l.dir[0], l.dir[1], l.dir[2]).normalize();
        const c = -_sdL.dot(_sdAxis) / Math.sqrt(Math.max(_sdL.lengthSq(), 1e-8));
        const t = Math.min(Math.max((c - cosO) / 0.08, 0), 1);
        w *= t * t * (3 - 2 * t);
      }
      _sdAcc.addScaledVector(_sdL, w);
      wsum += w;
    }
    if (wsum < 1e-5) _sdRaw.set(0, 1, 0, 0); // span 0 = no shadow
    else {
      _sdAcc.divideScalar(wsum);
      const len = Math.max(_sdAcc.length(), 1e-4);
      _sdRaw.set(_sdAcc.x / len, _sdAcc.y / len, _sdAcc.z / len, Math.min(len, 3));
    }
    // crossfade toward the fresh direction: a prop crossing a portal swaps
    // its light list and the caster-anchored direction SNAPPED the shadow
    // (Andre-caught, 2026-07-05). ~0.25s exponential settle, exact snap at
    // the end so the dynocc change-detector can put the splat back to sleep.
    const sd = e.shadowDir || (e.shadowDir = new THREE.Vector4().copy(_sdRaw));
    sd.lerp(_sdRaw, alpha);
    const dx = sd.x - _sdRaw.x, dy = sd.y - _sdRaw.y, dz = sd.z - _sdRaw.z;
    if (dx * dx + dy * dy + dz * dz < 1e-6 && Math.abs(sd.w - _sdRaw.w) < 1e-3) {
      sd.copy(_sdRaw);
    } else {
      const n = Math.max(Math.hypot(sd.x, sd.y, sd.z), 1e-4); // renormalize the
      sd.x /= n; sd.y /= n; sd.z /= n;                        // lerped direction
    }
  };
  const dynEntries = []; // pooled (72x/s)
  const updateDynOcc = (dt = 1) => {
    if (!dynOcc) return;
    const alpha = Math.min(1, dt * 4); // ~0.25s direction settle
    dynEntries.length = 0;
    for (const e of occluders.entries) {
      if (!e.p.mesh.visible) continue;
      shadowDirFor(e, alpha);
      dynEntries.push(e);
    }
    dynOcc.update(dynEntries, occDials());
  };
  if (params.has('occluders')) matsys.globals.uOccOn.value = parseFloat(params.get('occluders'));
  if (params.has('occsh')) matsys.globals.uOccShadow.value = parseFloat(params.get('occsh'));
  // dyn-effects budgets by platform (Andre-tuned): Quest is the tightest
  // (locked 72 at 9/9), phones hold 60 with headroom, PC is unconstrained.
  // ?occbudget= / ?occrange= pin values for A/B and skip the auto switch.
  const applyDynBudget = () => {
    const g = matsys.globals;
    if (params.has('occbudget')) g.uOccBudget.value = parseFloat(params.get('occbudget'));
    if (params.has('occrange')) g.uOccRange.value = parseFloat(params.get('occrange'));
    if (params.has('occbudget') || params.has('occrange')) return;
    // Quest range 12 (was 9): the shadow reach pre-reject + pack-time budget
    // made distant receivers nearly free, so the fade can sit farther out
    if (renderer.xr.isPresenting) { g.uOccBudget.value = 9; g.uOccRange.value = 12; }
    else if (isTouchDevice()) { g.uOccBudget.value = 16; g.uOccRange.value = 12; }
    else { g.uOccBudget.value = 32; g.uOccRange.value = 100; }
  };
  applyDynBudget();
  renderer.xr.addEventListener('sessionstart', applyDynBudget);
  renderer.xr.addEventListener('sessionend', applyDynBudget);
  // eye-buffer scale: ~19% fill at 0.9 for near-invisible sharpness loss
  // (Tier 2 item 3; ground-truth ~1.9ms at the gallery worst view).
  // Applies at session START - re-enter VR after changing the GUI slider
  renderer.xr.setFramebufferScaleFactor(
    params.has('fbscale') ? parseFloat(params.get('fbscale')) : 0.9);
  window.__setFbScale = v => renderer.xr.setFramebufferScaleFactor(v);
  const perf = new PerfHarness(scene); // GPU headroom probe (docs/unified-occluders.md)
  perf.attachGpuTimer(renderer); // real GPU ms where the browser exposes timer queries
  const state = { bounces: useLightmap ? 1 : 3, baking: false };
  const gui = buildGUI(matsys, state, wires, () => rebake(), () => relight(), culler, onStaticImposters, perf, audio, physWires);
  if (isTouchDevice()) gui.close(); // phones: collapsed to the title bar by default

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
    // fence-paced like relight(): at most one tick's worth of capture work
    // in flight (the old BAKE-mode budget of Infinity issued EVERY capture
    // in one JS turn - same queue-flood hazard, smaller draws)
    const gl = renderer.getContext();
    let fence = null;
    return new Promise(resolve => {
      const tick = () => {
        // a dead GL context no-ops every call: the generator would sprint
        // to the end and "finish" a black bake (Andre's master-bake run).
        // Stop loudly instead - there is nothing sane to resume.
        if (glLost) {
          overlayMsg.textContent = 'GPU CONTEXT LOST - bake aborted';
          overlaySub.textContent = 'lower lmrays / lmps and reload the page';
          return;
        }
        if (fence) {
          if (gl.clientWaitSync(fence, 0, 0) === gl.TIMEOUT_EXPIRED) {
            requestAnimationFrame(tick);
            return;
          }
          gl.deleteSync(fence);
          fence = null;
        }
        for (let i = 0; i < 6; i++) {
          if (steps.next().done) {
            state.baking = false;
            overlay.classList.add('hidden');
            resolve();
            return;
          }
          done++;
        }
        fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        gl.flush();
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
    // GPU FENCE PACING: the bake never touches the canvas, so nothing
    // backpressures rAF - the driver was ENQUEUEING strips at 60/s while
    // the GPU executed ~2/s. Minutes of queued work froze the whole
    // desktop's graphics and Chrome's GPU watchdog killed the process
    // (the master-bake context losses; progress was counting submissions,
    // not completions). One in-flight strip at a time: browser stays
    // interactive, the watchdog stays happy, progress becomes real.
    const gl = renderer.getContext();
    let fence = null;
    return new Promise(resolve => {
      const tick = () => {
        if (glLost) { // see rebake(): dead context = black "success"
          overlayMsg.textContent = 'GPU CONTEXT LOST - bake aborted';
          overlaySub.textContent = 'lower lmrays / lmps and reload the page';
          return;
        }
        if (fence) {
          if (gl.clientWaitSync(fence, 0, 0) === gl.TIMEOUT_EXPIRED) {
            requestAnimationFrame(tick); // GPU still chewing the last strip
            return;
          }
          gl.deleteSync(fence);
          fence = null;
        }
        if (steps.next().done) {
          matsys.globals.uLightmap.value = lightmapper.texture;
          matsys.setUseLightmap(true);
          state.baking = false;
          resolve(rebake());
          return;
        }
        fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        gl.flush(); // fences signal only once submitted
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

  // ?recube: regenerate ONLY the cubemap atlas (after an atlas-resolution
  // change) reusing the existing master lightmap. The lightmap is the
  // expensive path-traced artifact and is unaffected by the atlas layout,
  // so this skips the hour-long relight: load the lightmap, capture cubemaps
  // from the scene it lights, save atlas.bin + manifest (lightmap.bin stays).
  if (params.has('recube')) {
    if (!manifest) throw new Error('?recube needs an existing baked/manifest.json to reuse the lightmap');
    overlayMsg.textContent = 'Re-cube: loading master lightmap...';
    const lmTex = await loadHalfTexture('./baked/lightmap.bin', manifest.lightmap.w, manifest.lightmap.h, true);
    matsys.globals.uLightmap.value = lmTex;
    matsys.setUseLightmap(true);
    await rebake(); // cubemaps only, scene lit by the loaded lightmap
    const mb = await saveAtlasOnly(renderer, baker.atlasA, manifest);
    overlayMsg.textContent = `Atlas re-cubed (${mb.toFixed(1)} MB) at ${baker.atlasA.width}x${baker.atlasA.height}`;
    document.title = 'BAKE_SAVED';
    return;
  }

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
        loadHalfTexture('./baked/lightmap.bin', manifest.lightmap.w, manifest.lightmap.h, true),
      ]);
      matsys.globals.uAtlas.value = atlasTex;
      matsys.globals.uLightmap.value = lmTex;
      matsys.setUseLightmap(true);
      usedBaked = true;
    } catch (e) {
      errEl.textContent += `baked load failed (${e.message}); baking live\n`;
      // stale manifest also means stale lmSettings (offline-quality!) -- reload
      // on the live path with defaults instead of live-baking at bake quality
      const p = new URLSearchParams(location.search);
      if (p.get('baked') !== '0') {
        p.set('baked', '0');
        location.search = p.toString();
        return;
      }
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
    updateDynOcc();
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
  // controller world velocity: PEAK windowed estimate, not the full-window
  // average. A throw accelerates into release and the hand starts braking at
  // the exact release moment - averaging first-to-last over 120ms diluted
  // the peak with the wind-up AND the brake, so throws felt weak
  // (Andre, 2026-07-05). Try every sub-window ending at the newest sample
  // (span >= 25ms for noise) and keep the fastest.
  const ctrlVel = c => {
    const h = c && c.userData.hist;
    if (!h || h.length < 2) return new THREE.Vector3();
    const b = h[h.length - 1];
    const v = new THREE.Vector3();
    let best = 0;
    for (let i = 0; i < h.length - 1; i++) {
      const span = b.t - h[i].t;
      if (span < 0.025) break; // entries are time-ordered: rest are shorter
      const s2 = b.p.distanceToSquared(h[i].p) / (span * span);
      if (s2 > best) { best = s2; v.subVectors(b.p, h[i].p).divideScalar(span); }
    }
    return v;
  };
  // wrist angular velocity over the most recent ~50ms (quaternion delta)
  const _aq = new THREE.Quaternion();
  const ctrlAngVel = c => {
    const h = c && c.userData.hist;
    const w = new THREE.Vector3();
    if (!h || h.length < 2) return w;
    const b = h[h.length - 1];
    let a = h[0];
    for (let i = h.length - 2; i >= 0; i--) {
      if (b.t - h[i].t >= 0.04) { a = h[i]; break; }
    }
    const span = b.t - a.t;
    if (span < 1e-3) return w;
    _aq.copy(a.q).invert().premultiply(b.q); // world-frame delta rotation
    const s = Math.sqrt(Math.max(0, 1 - _aq.w * _aq.w));
    if (s < 1e-4) return w;
    const ang = 2 * Math.acos(Math.min(1, Math.abs(_aq.w)));
    return w.set(_aq.x, _aq.y, _aq.z)
      .multiplyScalar(((_aq.w < 0 ? -1 : 1) * ang) / (s * span));
  };
  // release the held prop with the full rigid-body velocity: hand velocity
  // + omega x r (the prop rides at an offset from the grip - a wrist flick
  // must carry it), and the wrist's real omega as the departing spin
  const _twr = new THREE.Vector3(), _twc = new THREE.Vector3();
  const throwRelease = c => {
    const key = c.userData.handed || 'right';
    const h = props.holds.get(key);
    const v = ctrlVel(c);
    const w = ctrlAngVel(c);
    if (h) {
      c.getWorldPosition(tmpV);
      _twr.subVectors(h.p.mesh.position, tmpV);
      v.add(_twc.crossVectors(w, _twr));
    }
    props.release(v, w, key);
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
  // ship at 90 (Andre 2026-07-05: locked at 90 with dynamic resolution -
  // show it off); A/X still toggles down to 72
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
      sh: g.uOccShadow.value,
    };
    const set = (steps, rh, occ, sh) => () => {
      g.uMaxSteps.value = steps;
      g.uRoughHops.value = rh;
      g.uOccOn.value = occ;
      g.uOccShadow.value = sh;
    };
    return {
      configs: [
        { name: 'occ-off', apply: set(3, 1, 0, 0) },  // baseline first
        { name: 'occluders', apply: set(3, 1, 1, 0) },
        { name: 'shadows', apply: set(3, 1, 1, 0.85) }, // occluders + shadow rays
        { name: 'flat-hops', apply: set(3, 0, 0, 0) },
        { name: 'steps0', apply: set(0, 1, 0, 0) },
      ],
      restore: () => {
        g.uMaxSteps.value = saved.steps;
        g.uRoughHops.value = saved.rh;
        g.uOccOn.value = saved.occ;
        g.uOccShadow.value = saved.sh;
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

  let vrMenu = null; // built inside the XR block, read by xrUpdate
  if (!navigator.xr) errEl.textContent += 'XR: navigator.xr missing (no WebXR in this browser)\n';
  if (navigator.xr && !SHOT && !BAKE) {
    renderer.xr.enabled = true;
    renderer.xr.setFoveation(0.5); // adaptive controller takes it from here
    document.body.appendChild(VRButton.createButton(renderer));
    navigator.xr.isSessionSupported('immersive-vr')
      .then(ok => { errEl.textContent += `XR: api ok, immersive-vr ${ok ? 'supported' : 'NOT SUPPORTED'}\n`; })
      .catch(e => { errEl.textContent += `XR: isSessionSupported threw: ${e.message || e}\n`; });
    renderer.xr.addEventListener('sessionstart', () => { errEl.textContent += 'XR: session started\n'; });
    renderer.xr.addEventListener('sessionend', () => { // desktop camera owns the rig again
      errEl.textContent += 'XR: session ended\n';
      rig.position.set(0, 0, 0);
      rig.rotation.set(0, 0, 0);
      for (const j of [0, 1]) { // controllers vanish: drop the props in place
        const cc = renderer.xr.getController(j);
        if (cc) { cc.userData.holding = false; cc.userData.hist = []; }
      }
      props.dropAll();
    });
    // in-VR menu on the LEFT hand: the MAIN page is for demo guests (the
    // big levers the technique is showing off), tuning lives one page down
    {
      const g = matsys.globals;
      const viewNames = ['none', 'cell tint', 'heatmap', 'irradiance', 'white', 'lightmap', 'spec only'];
      const wrap = (v, n, d) => (v + d + n) % n;
      let savedSteps = 3;
      const mkToggle = (name, get, set) => ({
        name, value: () => (get() ? 'on' : 'off'), adjust: () => set(!get()),
      });
      vrMenu = new VRMenu({
        main: [
          // THE headline A/B: full portal traversal vs plain parallax-
          // corrected cubemaps, one click
          mkToggle('portal rendering', () => g.uMaxSteps.value > 0, on => {
            if (on) g.uMaxSteps.value = savedSteps || 3;
            else { savedSteps = g.uMaxSteps.value || 3; g.uMaxSteps.value = 0; }
          }),
          mkToggle('reflections', () => matsys.specularOn, on => matsys.setSpecular(on)),
          mkToggle('AO + shadows', () => g.uOccOn.value > 0.5,
            on => { g.uOccOn.value = on ? 1 : 0; }),
          { name: 'framerate target', value: () => rateState.target + 'Hz',
            adjust: () => {
              rateState.target = rateState.target === 90 ? 72 : 90;
              drawRate();
              applyRate(renderer.xr.getSession());
            } },
          { name: 'tuning', value: () => '>', adjust: () => vrMenu.setPage('tuning') },
        ],
        tuning: [
          { name: 'debug view', value: () => viewNames[g.uDebugMode.value],
            adjust: d => {
              g.uDebugMode.value = wrap(g.uDebugMode.value, 7, d);
              matsys.setDebugCompiled(g.uDebugMode.value > 0); // rebuild hitch, expected
            } },
          mkToggle('lightmap', () => g.uUseLightmap.value > 0.5,
            on => matsys.setUseLightmap(on)),
          mkToggle('dyn shadows', () => g.uOccShadow.value > 0.001,
            on => { g.uOccShadow.value = on ? 0.85 : 0; }),
          { name: 'portal hops (glass)', value: () => String(g.uMaxSteps.value),
            adjust: d => { g.uMaxSteps.value = wrap(g.uMaxSteps.value, 7, d); } },
          { name: 'blob hops', value: () => String(g.uOccHops.value),
            adjust: d => { g.uOccHops.value = wrap(g.uOccHops.value, 5, d); } },
          { name: 'exposure EV', value: () => Math.log2(g.uExposure.value).toFixed(2),
            adjust: d => {
              let ev = Math.log2(g.uExposure.value) + d * 0.25;
              if (ev > 2) ev = -5; // clicks cycle; stick still goes both ways
              g.uExposure.value = Math.pow(2, ev);
            } },
          mkToggle('portal wires', () => wires.visible, on => { wires.visible = on; }),
          mkToggle('collision wires', () => physWires.group.visible,
            on => { physWires.group.visible = on; }),
          mkToggle('portal culling', () => culler.enabled, on => { culler.enabled = on; }),
          { name: 'perf batch', value: () => (perf.batch || perf.sweep) ? 'RUNNING' : 'run',
            adjust: () => {
              if (perf.batch || perf.sweep) perf.cancelBatch();
              else { const b = perf.batchSetup(); perf.startBatch(b.configs, b.restore); }
            } },
          { name: 'back', value: () => '<', adjust: () => vrMenu.setPage('main') },
        ],
      });
    }
    for (const i of [0, 1]) {
      const c = renderer.xr.getController(i);
      rig.add(c);
      // the menu + prompt ride whichever controller reports LEFT handedness;
      // handedness also keys the per-hand prop holds
      c.addEventListener('connected', e => {
        if (!e.data) return;
        c.userData.handed = e.data.handedness;
        if (e.data.handedness === 'left' && vrMenu) {
          c.add(vrMenu.mesh);
          c.add(vrMenu.prompt);
        }
      });
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
        const key = c.userData.handed || (i === 0 ? 'left' : 'right');
        // pointing at the open menu: the trigger CLICKS instead of grabbing
        if (vrMenu && vrMenu.open && vrMenu.hoverRow >= 0 && key === 'right') {
          vrMenu.click();
          return;
        }
        if (c.userData.holding) return; // this hand is full
        const car = ctrlCarrier(c);
        // sphere grab near the hand (0.15m pad); grabbing a prop the OTHER
        // hand holds STEALS it - that is the hand-to-hand transfer. Each
        // hand carries its own prop.
        const near = props.touch(car.pos, 0.15);
        if (near) {
          const prev = props.holderKey(near);
          if (prev && prev !== key) {
            const other = renderer.xr.getController(1 - i);
            if (other) other.userData.holding = false;
          }
          props.grabAttach(near, car, key);
          c.userData.holding = true;
          return;
        }
        const p = props.aim(car.pos, car.viewDir, 3.0);
        if (p && !props.holderKey(p)) { // ray-grab free props only
          props.grabBeam(p, car, key);
          c.userData.holding = true;
        }
      });
      c.addEventListener('selectend', () => {
        if (!c.userData.holding) return;
        c.userData.holding = false;
        throwRelease(c);
      });
    }
  }
  let snapReady = true;
  const menuRay = new THREE.Raycaster();
  menuRay.layers.enableAll(); // the menu lives on debug layer 3
  const menuDir = new THREE.Vector3();
  // pooled per-frame vectors + the ray-mode carrier (GC pauses on the Quest
  // browser read as unexplained one-frame drops at a locked 72)
  const heading = new THREE.Vector3();
  const right = new THREE.Vector3();
  const rayCarrier = { pos: null, quat: null, viewDir: heading, vel: new THREE.Vector3(), eye: new THREE.Vector3(), mode: 'ray' };
  function xrUpdate(dt) {
    // three's XR eye cameras have their OWN layer masks (0|1 and 0|2) - our
    // dynamic layer 3 must be enabled on them or props vanish in-session
    const xrCam = renderer.xr.getCamera();
    xrCam.layers.enable(3);
    for (const c of xrCam.cameras) c.layers.enable(3);
    camera.getWorldPosition(headPos);
    const session = renderer.xr.getSession();
    heading.set(0, 0, -1).applyQuaternion(camera.getWorldQuaternion(tmpQ));
    heading.y = 0;
    heading.normalize();
    right.set(-heading.z, 0, heading.x);
    // debug menu first: while open it owns the right stick + A (snap turn
    // and the rate toggle are suppressed); left X toggles it
    let leftPad = null, rightPad = null;
    for (const src of session.inputSources) {
      if (src.handedness === 'left') leftPad = src.gamepad;
      else if (src.handedness === 'right') rightPad = src.gamepad;
    }
    const menuActive = vrMenu ? vrMenu.update(leftPad, rightPad) : false;
    for (const src of session.inputSources) {
      const a = src.gamepad && src.gamepad.axes;
      if (!a || a.length < 4) continue;
      const x = a[2], y = a[3];
      if (src.handedness === 'left' && (Math.abs(x) > 0.15 || Math.abs(y) > 0.15)) {
        rig.position.addScaledVector(heading, -y * 2.5 * dt);
        rig.position.addScaledVector(right, x * 2.5 * dt);
      }
      if (src.handedness === 'right') { // snap turn stays live with the menu
        if (Math.abs(x) > 0.7 && snapReady) { // open: turn to inspect debug views
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
    // no raw A/B/Y bindings anymore: rate + perf batch live in the menu
    // (unlabeled mystery buttons read as broken to demo guests). A is the
    // menu's activate button; X toggles the menu.
    // hover: the RIGHT hand's ray picks menu rows; trigger clicks them
    if (vrMenu && vrMenu.open) {
      let rc = null;
      for (const j of [0, 1]) {
        const cc = renderer.xr.getController(j);
        if (cc && cc.userData.handed === 'right') rc = cc;
      }
      if (rc) {
        rc.getWorldPosition(menuRay.ray.origin);
        menuDir.set(0, 0, -1).applyQuaternion(rc.getWorldQuaternion(tmpQ));
        menuRay.ray.direction.copy(menuDir);
        const hit = menuRay.intersectObject(vrMenu.mesh, false)[0];
        vrMenu.pointAt(hit && hit.uv ? hit.uv : null);
      } else {
        vrMenu.pointAt(null);
      }
    }
    // hull collision on the head position; apply the correction to the rig
    camera.getWorldPosition(headPos);
    player.pos.set(headPos.x, 1.7, headPos.z);
    player.cell = findCell(level.cells, player.pos, player.cell);
    player.collide(level.colliders);
    rig.position.x += player.pos.x - headPos.x;
    rig.position.z += player.pos.z - headPos.z;
    // per-controller pose history (post-locomotion) feeds swing-release
    // throws: position for linear velocity, orientation for the wrist omega
    const now = performance.now() * 0.001;
    for (const j of [0, 1]) {
      const cc = renderer.xr.getController(j);
      if (!cc) continue;
      cc.getWorldPosition(tmpV);
      cc.getWorldQuaternion(tmpQ);
      const hist = cc.userData.hist || (cc.userData.hist = []);
      let spare = null; // recycle expired entries instead of allocating
      while (hist.length > 2 && now - hist[0].t > 0.15) spare = hist.shift();
      if (spare) { spare.p.copy(tmpV); spare.q.copy(tmpQ); spare.t = now; hist.push(spare); }
      else hist.push({ p: tmpV.clone(), q: tmpQ.clone(), t: now });
    }
    // per-hand carriers: each holding hand drives its own prop
    props.carriers.left = null;
    props.carriers.right = null;
    for (const j of [0, 1]) {
      const cc = renderer.xr.getController(j);
      if (cc && cc.userData.holding) {
        props.carriers[cc.userData.handed || (j === 0 ? 'left' : 'right')] = ctrlCarrier(cc);
      }
    }
    rayCarrier.pos = player.pos;
    rayCarrier.vel.set(0, 0, 0);
    rayCarrier.eye.copy(headPos);
    xrCarrier = rayCarrier; // fallback only (desktop-key holds don't exist in VR)
  }

  const occActive = new Set();
  const occOrder = []; // pooled priority order (visible -> ring1 -> ring2)
  const skyCells = [level.cells.find(c => c.sky).id, level.cells.find(c => c.hollow).id];
  // adaptive quality: sharp periphery (low foveation) + full dyn range in the
  // cheap rooms - most of them - ratcheting up foveation and pulling the dyn
  // range in only when frames actually drop. Load is very room-dependent;
  // static worst-case settings taxed every room for the two hot views.
  const adapt = { fov: 0.5, t: 0 };
  const adaptTick = dt => {
    adapt.t += dt;
    if (adapt.t < 0.5) return;
    adapt.t = 0;
    const med = perf.medianMs();
    const ds = perf.deltas;
    if (!med || ds.length < 40) return;
    let drops = 0;
    const n = Math.min(60, ds.length);
    for (let i = ds.length - n; i < ds.length; i++) if (ds[i] > med * 1.5) drops++;
    const rate = drops / n;
    const prev = adapt.fov;
    if (rate > 0.05) adapt.fov = Math.min(1.0, adapt.fov + 0.15);      // degrade fast
    else if (rate < 0.01) adapt.fov = Math.max(0.35, adapt.fov - 0.05); // recover slow
    if (adapt.fov !== prev) renderer.xr.setFoveation(adapt.fov);
    // the dyn-effects range rides the same signal (params/desktop pins win)
    if (!params.has('occrange') && renderer.xr.isPresenting) {
      matsys.globals.uOccRange.value = adapt.fov > 0.85 ? 9 : 12;
    }
  };
  let last = performance.now(), fpsAvg = 0;
  // scripted gag: the hall-A ceiling fan drops 1.5s after you walk in.
  // its dynamic body spawns asleep at the ceiling (gravity frozen while
  // sleeping - that is what holds it up); one wakeUp() and it falls and
  // clatters on the floor (the collide event fires the impact thunk).
  // ?fandrop=1 forces the drop at boot to spot-check the landing.
  const fanDrop = (() => {
    const fan = props.list.find(p => p.slug === 'ceiling_fan');
    if (!fan) { console.warn('ceiling_fan not found - drop gag disabled'); return { tick() {} }; }
    const room = fan.cell; // hall A, captured before the fan can move
    const force = params.get('fandrop') === '1';
    let t = 0, done = false;
    return {
      tick(dt, cell) {
        if (done || !fan.body) return;
        if (force) { fan.body.wakeUp(); done = true; return; }
        // count only while you are in the room, so you always witness it -
        // step out before 1.5s and the countdown restarts on re-entry
        if (cell !== room) { t = 0; return; }
        t += dt;
        if (t >= 1.5) { fan.body.wakeUp(); done = true; }
      },
    };
  })();

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
          adaptTick(dt);
        } catch (e) { // surface XR-path crashes on the page (visible after exit)
          errEl.textContent += `XR loop error: ${e.message}\n`;
        }
      } else {
        player.update(dt, level.colliders);
        props.update(dt, player);
      }
      fanDrop.tick(dt, player.cell); // player.cell is fresh in both modes here
      // listener follows the (XR) camera; footsteps from horizontal travel.
      // VR passes walking=true - the speed gate in audio ignores head sway
      audio.update(dt, inXR ? renderer.xr.getCamera() : camera, player.pos,
        inXR || (player.locked && !player.noclip));
    }
    // portal-frustum culling: only cells reachable through on-screen portals
    // draw (reflections are atlas-based and immune). All-visible during bakes.
    if (culler.enabled && !state.baking) {
      culler.compute(inXR ? renderer.xr.getCamera() : camera, inXR ? headPos : player.pos);
    }
    culler.apply(staticGroup, props, state.baking);
    // the dome is not in staticGroup and its radius-70 sphere contains every
    // camera, so nothing else ever culls it: it was binned in every room,
    // both eyes. Only sky-adjacent cells can actually see it.
    dome.visible = state.baking || !culler.enabled ||
      culler.visible.has(skyCells[0]) || culler.visible.has(skyCells[1]);
    if (occluders && !state.baking) {
      // occluder slots in PRIORITY order: visible cells, then one ring of
      // portal neighbors, then a SECOND ring (Andre: blobs popped into deep
      // sphere reflections as the active set changed - the full march sees
      // 2-3 portals deep). Slot exhaustion now drops ring 2 first, so the
      // extra ring only spends what nearer cells left over.
      let active = null;
      if (culler.enabled) {
        occActive.clear();
        occOrder.length = 0;
        const pushCell = c => {
          if (!occActive.has(c)) { occActive.add(c); occOrder.push(c); }
        };
        for (const c of culler.visible) pushCell(c);
        const n1 = occOrder.length;
        for (let i = 0; i < n1; i++) {
          for (const po of level.cells[occOrder[i]].portals) pushCell(po.neighbor);
        }
        const n2 = occOrder.length;
        for (let i = n1; i < n2; i++) {
          for (const po of level.cells[occOrder[i]].portals) pushCell(po.neighbor);
        }
        active = occOrder;
      }
      // closest-first dyn packing; the capsule budget truncates at pack time
      occluders.update(active, inXR ? headPos : player.pos,
        matsys.globals.uOccBudget.value);
      updateDynOcc(dt); // after occluders.update: it reads the fresh e.world
    }
    if (physWires.group.visible) physWires.update(); // sync dynamic bodies
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
