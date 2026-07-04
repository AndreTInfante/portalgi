// GPU headroom probe (docs/unified-occluders.md, "Measurement methodology").
//
// The Quest browser exposes no GPU timer queries and a vsynced 90Hz only
// shows quantized frame misses - so headroom is measured by CALIBRATED
// SYNTHETIC LOAD: a fullscreen burn pass adds ALU work in controlled steps;
// the sweep raises it until the dropped-frame rate crosses a threshold. The
// highest sustainable level is the headroom, in burn units. Running the same
// sweep at 90Hz and 72Hz caps spans exactly 2.78ms of frame budget, which
// calibrates burn units into milliseconds on the actual device.
//
// A/B: feature cost in ms = (tip without feature - tip with) x ms-per-unit.
import * as THREE from 'three';

const BURN_VERT = /* glsl */`
void main() { gl_Position = vec4(position.xy, 0.999, 1.0); }
`;

// fragCoord-seeded so the loop can't constant-fold; writes ~0 additively so
// the image is unchanged while the ALU work is real
const BURN_FRAG = /* glsl */`
precision highp float;
uniform float uBurn;
void main() {
  float acc = fract(gl_FragCoord.x * 0.1731 + gl_FragCoord.y * 0.2113);
  for (int i = 0; i < int(uBurn); i++) {
    acc = fract(acc * 1.3717 + 0.1731) + sin(acc * 12.9898) * 0.001;
  }
  gl_FragColor = vec4(acc * 1e-8, 0.0, 0.0, 0.0);
}
`;

const SETTLE_MS = 700;    // let the pipeline reach steady state after a step
const MEASURE_MS = 2600;  // measurement window per level
const DROP_FACTOR = 1.55; // delta > this x median period counts as a miss

export class PerfHarness {
  constructor(scene) {
    this.mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: BURN_VERT,
      fragmentShader: 'layout(location=0) out vec4 fragOut;\n#define gl_FragColor fragOut\n' + BURN_FRAG,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      uniforms: { uBurn: { value: 0 } },
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position',
      new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 999;   // after everything, both XR eyes
    this.mesh.layers.set(3);       // never in bake captures
    this.mesh.visible = false;
    scene.add(this.mesh);

    this.burn = 0;
    this.gpuMs = 0;               // rolling real GPU frame time (0 = no timer ext)
    this._gpu = null;             // { ext, gl, active, pending: [] }
    this.step = 20;               // sweep increment (burn units)
    this.maxLevel = 600;
    this.threshold = 5;           // % dropped frames = tipped over
    this.deltas = [];             // recent frame deltas (ms)
    this.sweep = null;
    this.batch = null;            // one-button config matrix (startBatch)
    this.batchReport = '';
    this.onBatchDone = null;
    this.lastReport = '';
    this._last = undefined;
    this._hud = '';
  }

  // run a list of {name, apply()} configs back to back, one sweep each, and
  // report every number at the end; restoreFn puts the app state back
  startBatch(configs, restoreFn) {
    if (this.sweep || this.batch) return;
    this.batch = { configs, restoreFn, i: 0, results: [] };
    this.batchReport = '';
    this._batchNext();
  }

  cancelBatch() {
    if (this.sweep) this.cancelSweep();
    if (this.batch) {
      if (this.batch.restoreFn) this.batch.restoreFn();
      this.batch = null;
    }
    this._hud = 'batch cancelled';
  }

  _batchNext() {
    const b = this.batch;
    if (b.i >= b.configs.length) { this._batchFinish(); return; }
    const c = b.configs[b.i];
    console.log(`perf batch: applying ${b.i + 1}/${b.configs.length} ${c.name}`);
    c.apply();
    this._hud = `batch ${b.i + 1}/${b.configs.length} ${c.name}`;
    // let the pipeline settle on the new config before measuring
    setTimeout(() => {
      if (!this.batch) return;
      console.log(`perf batch: sweeping ${c.name}`);
      this.startSweep(c.name);
    }, 500);
  }

  _batchFinish() {
    const b = this.batch;
    const lines = ['PERF BATCH (sustainable burn, higher = cheaper)'];
    const base = b.results.length ? b.results[0] : null;
    for (let i = 0; i < b.results.length; i++) {
      const r = b.results[i];
      const d = i === 0 ? 'baseline'
        : `${r.sust - base.sust >= 0 ? '+' : ''}${r.sust - base.sust}u vs ${base.name}`;
      const gpu = r.gpu > 0 ? ` gpu${r.gpu.toFixed(1)}` : '';
      lines.push(`${r.name.padEnd(10)} ${String(r.sust).padStart(4)}u${gpu}  (${d})`);
    }
    this.batchReport = lines.join('\n');
    console.log(this.batchReport);
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('perfLog',
          (localStorage.getItem('perfLog') || '') + this.batchReport + '\n');
      }
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        navigator.clipboard.writeText(this.batchReport).catch(() => {});
      }
    } catch (e) { /* headless */ }
    if (b.restoreFn) b.restoreFn();
    this.batch = null;
    this._hud = 'batch done';
    if (this.onBatchDone) this.onBatchDone(this.batchReport);
  }

  setBurn(n) {
    this.burn = Math.max(0, Math.round(n));
    this.mat.uniforms.uBurn.value = this.burn;
    this.mesh.visible = this.burn > 0;
  }

  // real GPU frame timing via EXT_disjoint_timer_query_webgl2, where the
  // browser exposes it (post-Spectre it often does not - probe, don't assume;
  // everything degrades silently to the burn-sweep when absent)
  attachGpuTimer(renderer) {
    const gl = renderer.getContext();
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    console.log(`perf: GPU timer queries ${ext ? 'AVAILABLE' : 'absent'} on this browser`);
    if (ext) this._gpu = { ext, gl, active: null, pending: [] };
  }

  gpuBegin() {
    const g = this._gpu;
    if (!g || g.active || g.pending.length > 6) return;
    g.active = g.gl.createQuery();
    g.gl.beginQuery(g.ext.TIME_ELAPSED_EXT, g.active);
  }

  gpuEnd() {
    const g = this._gpu;
    if (!g || !g.active) return;
    g.gl.endQuery(g.ext.TIME_ELAPSED_EXT);
    g.pending.push(g.active);
    g.active = null;
    // harvest oldest finished query (results land a few frames later)
    while (g.pending.length) {
      const q = g.pending[0];
      if (!g.gl.getQueryParameter(q, g.gl.QUERY_RESULT_AVAILABLE)) break;
      const disjoint = g.gl.getParameter(g.ext.GPU_DISJOINT_EXT);
      if (!disjoint) {
        const ms = g.gl.getQueryParameter(q, g.gl.QUERY_RESULT) / 1e6;
        this.gpuMs = this.gpuMs ? this.gpuMs * 0.9 + ms * 0.1 : ms;
      }
      g.gl.deleteQuery(q);
      g.pending.shift();
    }
  }

  medianMs() {
    if (this.deltas.length < 20) return 0;
    const s = [...this.deltas].sort((a, b) => a - b);
    return s[s.length >> 1];
  }

  // one call per rendered frame, with the loop's performance.now()
  tick(nowMs) {
    let d;
    if (this._last !== undefined) {
      d = nowMs - this._last;
      if (d > 0 && d < 250) {
        this.deltas.push(d); // ring buffer feeds the vsync-period median
        if (this.deltas.length > 240) this.deltas.shift();
      }
      // sweep accounting keeps slower frames too (they are DROPS, not gaps) -
      // discarding them made a pathological config read as 0% dropped
      if (!(d > 0 && d < 5000)) d = undefined;
    }
    this._last = nowMs;
    if (this.sweep) this._tickSweep(nowMs, d);
  }

  startSweep(config) {
    if (this.sweep) return;
    this.sweep = {
      config: config || '',
      level: 0, // level 0 first: baseline drop rate without burn
      phase: 'settle', t0: performance.now(), tStart: performance.now(),
      period: 0, frames: 0, drops: 0,
      results: [],
    };
    this.setBurn(0);
    this._hud = 'sweep: baseline';
  }

  cancelSweep() {
    if (!this.sweep) return;
    this.sweep = null;
    this.setBurn(0);
    this._hud = 'sweep cancelled';
  }

  _tickSweep(now, d) {
    const s = this.sweep;
    if (now - s.tStart > 90000) { // pathological config: bail with what we have
      if (s.hi === undefined) s.hi = s.level;
      this._finish();
      return;
    }
    if (s.phase === 'settle') {
      if (now - s.t0 > SETTLE_MS) {
        s.phase = 'measure';
        s.t0 = now;
        s.frames = 0;
        s.drops = 0;
        s.period = this.medianMs() || 11.1;
      }
      return;
    }
    if (d !== undefined) {
      s.frames++;
      if (d > s.period * DROP_FACTOR) s.drops++;
    }
    this._hud = `sweep ${s.level}u ${(100 * s.drops / Math.max(s.frames, 1)).toFixed(0)}%`;
    if (now - s.t0 < MEASURE_MS) return;
    const pct = s.frames ? (100 * s.drops / s.frames) : 0;
    s.results.push([s.level, pct]);
    if (pct > this.threshold) s.hi = s.level; else s.lo = s.level;
    // climb by full steps until the first tip, then bisect (lo, hi) down to
    // ~5u resolution (~0.25ms) - step quantization otherwise puts +-1ms error
    // bars on A/B differences
    let next = null;
    if (s.hi === undefined) {
      if (s.level < this.maxLevel) next = s.level + this.step;
    } else if (s.lo !== undefined && s.hi - s.lo > Math.max(this.step / 4, 5)) {
      next = Math.round((s.lo + s.hi) / 2);
    }
    if (next === null) {
      this._finish();
    } else {
      s.level = next;
      this.setBurn(next);
      s.phase = 'settle';
      s.t0 = now;
    }
  }

  _finish() {
    const s = this.sweep;
    const sustainable = s.lo !== undefined ? s.lo : 0;
    const tip = s.hi !== undefined ? `${s.hi}u` : `>${this.maxLevel}u`;
    const detail = s.results.map(([l, p]) => `${l}u:${p.toFixed(1)}%`).join(' ');
    this.lastReport = `[${s.config}] sustainable=${sustainable}u tip=${tip} | ${detail}`;
    console.log('perf sweep:', this.lastReport);
    this.sweep = null;
    this.setBurn(0);
    if (this.batch) { // batch mode: collect and move on
      this.batch.results.push({ name: s.config, sust: sustainable, tip, gpu: this.gpuMs });
      this.batch.i++;
      this._batchNext();
      return;
    }
    this._hud = `DONE sust=${sustainable}u`;
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('perfLog',
          (localStorage.getItem('perfLog') || '') + this.lastReport + '\n');
      }
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        navigator.clipboard.writeText(this.lastReport).catch(() => {});
      }
    } catch (e) { /* headless */ }
  }

  // compact status line for the desktop overlay / in-VR wrist label
  hudText() {
    const med = this.medianMs();
    const fps = med > 0 ? (1000 / med).toFixed(0) : '--';
    const gpu = this.gpuMs > 0 ? ` gpu${this.gpuMs.toFixed(1)}ms` : '';
    if (this.sweep) return `${fps}fps${gpu} ${this._hud}`;
    if (this.burn > 0) return `${fps}fps${gpu} burn ${this.burn}u`;
    const idle = this._hud ? `${fps}fps${gpu} ${this._hud}` : (gpu ? `${fps}fps${gpu}` : '');
    return idle;
  }
}
