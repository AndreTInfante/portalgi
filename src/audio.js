// Web Audio layer: faint looped music + procedurally synthesized footsteps and
// prop-impact thunks (no sample assets needed; music.mp3 is optional).
// Everything is inert until unlock() runs inside a user gesture - browsers
// refuse to start an AudioContext otherwise, and headless shots never gesture.

const MUSIC_URL = './assets/audio/music.mp3';

export class AudioSystem {
  constructor() {
    this.ctx = null;
    this._master = 1.0;
    this._music = 0.03;
    this._sfx = 1.0;
    let m = false;
    try { m = localStorage.getItem('pgi-muted') === '1'; } catch (e) { /* blocked storage */ }
    this._muted = m;
    this.stepDist = 0;   // accumulated horizontal travel since the last footstep
    this.lastStepT = 0;
    this.prevPos = null;
  }

  _applyMaster() { if (this.masterGain) this.masterGain.gain.value = this._muted ? 0 : this._master; }
  get master() { return this._master; }
  set master(v) { this._master = v; this._applyMaster(); }
  get muted() { return this._muted; }
  set muted(v) {
    this._muted = v;
    this._applyMaster();
    try { localStorage.setItem('pgi-muted', v ? '1' : '0'); } catch (e) { /* blocked storage */ }
  }
  get music() { return this._music; }
  set music(v) { this._music = v; if (this.musicGain) this.musicGain.gain.value = v; }
  get sfx() { return this._sfx; }
  set sfx(v) { this._sfx = v; if (this.sfxGain) this.sfxGain.gain.value = v; }

  unlock() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.masterGain = this.ctx.createGain();
    this.masterGain.connect(this.ctx.destination);
    this._applyMaster();
    this.musicGain = this.ctx.createGain();
    this.musicGain.gain.value = this._music;
    this.musicGain.connect(this.masterGain);
    this.sfxGain = this.ctx.createGain();
    this.sfxGain.gain.value = this._sfx;
    this.sfxGain.connect(this.masterGain);
    // shared 1s white-noise buffer; every one-shot reads a random slice of it
    const n = this.ctx.sampleRate;
    this.noise = this.ctx.createBuffer(1, n, n);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    this._loadMusic();
  }

  async _loadMusic() {
    try {
      const res = await fetch(MUSIC_URL);
      if (!res.ok) return; // no track shipped - demo stays silent-but-for-sfx
      const buf = await this.ctx.decodeAudioData(await res.arrayBuffer());
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.connect(this.musicGain);
      src.start();
    } catch (e) { /* decode/network failure: music is optional */ }
  }

  // per-frame: move the listener to the camera and accumulate footstep travel.
  // `walking` gates accumulation (desktop: pointer-locked && !noclip; VR: true -
  // the speed gate below already ignores leaning, which is well under 0.7 m/s).
  update(dt, cam, walkPos, walking) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const e = cam.matrixWorld.elements;
    this._setListener(e[12], e[13], e[14], -e[8], -e[9], -e[10], e[4], e[5], e[6]);
    if (!this.prevPos) this.prevPos = { x: walkPos.x, z: walkPos.z };
    const dx = walkPos.x - this.prevPos.x, dz = walkPos.z - this.prevPos.z;
    this.prevPos.x = walkPos.x; this.prevPos.z = walkPos.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 0.5) return; // teleport / snap-turn correction, not travel
    const speed = dist / Math.max(dt, 1e-4);
    if (!walking || speed < 0.7) { this.stepDist = Math.max(0, this.stepDist - dt); return; }
    this.stepDist += dist;
    const t = this.ctx.currentTime;
    if (this.stepDist > 1.1 && t - this.lastStepT > 0.31) {
      this.stepDist = 0;
      this.lastStepT = t;
      this._step();
    }
  }

  _setListener(px, py, pz, fx, fy, fz, ux, uy, uz) {
    const l = this.ctx.listener;
    if (l.positionX) {
      l.positionX.value = px; l.positionY.value = py; l.positionZ.value = pz;
      l.forwardX.value = fx; l.forwardY.value = fy; l.forwardZ.value = fz;
      l.upX.value = ux; l.upY.value = uy; l.upZ.value = uz;
    } else {
      l.setPosition(px, py, pz);
      l.setOrientation(fx, fy, fz, ux, uy, uz);
    }
  }

  _noiseBurst(dest, t, { freq, q, gain, decay, type = 'bandpass' }) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const f = this.ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(1e-4, t + decay);
    src.connect(f).connect(g).connect(dest);
    // keep the slice inside the 1s buffer or the tail cuts off early
    src.start(t, Math.random() * 0.7, decay + 0.05);
  }

  // step on stone: mostly low-end body with a soft mid tap (no bright tick)
  _step() {
    const t = this.ctx.currentTime;
    const v = 0.8 + Math.random() * 0.4;
    this._noiseBurst(this.sfxGain, t, {
      freq: 700 + Math.random() * 300, q: 1.2, gain: 0.02 * v, decay: 0.03,
    });
    this._noiseBurst(this.sfxGain, t, {
      freq: 110 + Math.random() * 40, q: 1.0, gain: 0.14 * v, decay: 0.11,
    });
  }

  // positional prop-vs-hull thunk; pitch falls with prop size, gain with speed
  impact(pos, speed, radius = 0.2) {
    if (!this.ctx || this.ctx.state !== 'running' || speed < 0.5) return;
    const t = this.ctx.currentTime;
    const amp = Math.min(1, (speed - 0.4) / 5);
    const pan = this.ctx.createPanner();
    pan.panningModel = 'equalpower';
    pan.distanceModel = 'inverse';
    pan.refDistance = 1;
    pan.maxDistance = 40;
    if (pan.positionX) {
      pan.positionX.value = pos.x; pan.positionY.value = pos.y; pan.positionZ.value = pos.z;
    } else pan.setPosition(pos.x, pos.y, pos.z);
    pan.connect(this.sfxGain);
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    const f0 = 55 + 28 / Math.max(radius, 0.1) * (0.9 + Math.random() * 0.2);
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(f0 * 0.6, t + 0.12);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.5 * amp, t);
    g.gain.exponentialRampToValueAtTime(1e-4, t + 0.14);
    osc.connect(g).connect(pan);
    osc.start(t); osc.stop(t + 0.16);
    this._noiseBurst(pan, t, {
      freq: 650, q: 0.8, gain: 0.25 * amp, decay: 0.045, type: 'lowpass',
    });
  }
}
