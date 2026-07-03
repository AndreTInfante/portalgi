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
    this.step = 20;               // sweep increment (burn units)
    this.maxLevel = 600;
    this.threshold = 5;           // % dropped frames = tipped over
    this.deltas = [];             // recent frame deltas (ms)
    this.sweep = null;
    this.lastReport = '';
    this._last = undefined;
    this._hud = '';
  }

  setBurn(n) {
    this.burn = Math.max(0, Math.round(n));
    this.mat.uniforms.uBurn.value = this.burn;
    this.mesh.visible = this.burn > 0;
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
        this.deltas.push(d);
        if (this.deltas.length > 240) this.deltas.shift();
      } else {
        d = undefined; // tab-hidden gap etc.
      }
    }
    this._last = nowMs;
    if (this.sweep) this._tickSweep(nowMs, d);
  }

  startSweep(config) {
    if (this.sweep) return;
    this.sweep = {
      config: config || '',
      level: 0, // level 0 first: baseline drop rate without burn
      phase: 'settle', t0: performance.now(),
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
    this._hud = `DONE sust=${sustainable}u`;
    console.log('perf sweep:', this.lastReport);
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('perfLog',
          (localStorage.getItem('perfLog') || '') + this.lastReport + '\n');
      }
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        navigator.clipboard.writeText(this.lastReport).catch(() => {});
      }
    } catch (e) { /* headless */ }
    this.sweep = null;
    this.setBurn(0);
  }

  // compact status line for the desktop overlay / in-VR wrist label
  hudText() {
    const med = this.medianMs();
    const fps = med > 0 ? (1000 / med).toFixed(0) : '--';
    if (this.sweep) return `${fps}fps ${this._hud}`;
    if (this.burn > 0) return `${fps}fps burn ${this.burn}u`;
    return this._hud ? `${fps}fps ${this._hud}` : '';
  }
}
