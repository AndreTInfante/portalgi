// In-VR menu: a canvas panel on the LEFT hand, toggled with X. The main page
// holds the top-level levers (portals on/off vs PCCM, reflections, AO+shadows,
// framerate target); detailed controls live on the 'tuning' subpage. Interact
// by POINTING the right hand at a row and pulling the trigger (main.js raycasts
// and routes the trigger here instead of grabbing), or right stick + A. A
// one-line help string lives inside the panel; an always-on prompt under the
// left hand says how to open it.
import * as THREE from 'three';

const W = 512, H = 640;
const ROW = 46, TOP = 110; // row baseline layout; hit band starts at TOP-30

export class VRMenu {
  // pages: { main: [...], tuning: [...] } - item: { name, value():string,
  // adjust(dir) }. adjust(+1) must CYCLE multi-state values (click has no
  // direction); stick left/right supplies real -1/+1.
  constructor(pages) {
    this.pages = pages;
    this.page = 'main';
    this.open = false;
    this.sel = 0;
    this.hoverRow = -1;
    this._sig = '';
    this._nav = { x: true, y: true, a: true, menu: true };

    this.canvas = document.createElement('canvas');
    this.canvas.width = W; this.canvas.height = H;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(0.26, 0.325),
      new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, depthTest: false }));
    this.mesh.position.set(0, 0.2, -0.08);
    this.mesh.rotation.x = -0.5;
    this.mesh.layers.set(3);
    this.mesh.visible = false;
    this.mesh.renderOrder = 10;

    // always-on hand prompt showing the basic controls
    const pc = document.createElement('canvas');
    pc.width = 512; pc.height = 96;
    const ctx = pc.getContext('2d');
    ctx.fillStyle = 'rgba(10,12,16,0.55)';
    ctx.fillRect(0, 0, 512, 96);
    ctx.fillStyle = '#cfe3ff';
    ctx.font = 'bold 30px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText('trigger: grab / throw', 256, 40);
    ctx.fillText('X: menu', 256, 78);
    const ptex = new THREE.CanvasTexture(pc);
    this.prompt = new THREE.Mesh(
      new THREE.PlaneGeometry(0.14, 0.026),
      new THREE.MeshBasicMaterial({ map: ptex, transparent: true, depthTest: false }));
    this.prompt.position.set(0, -0.02, 0.06);
    this.prompt.rotation.x = -0.9;
    this.prompt.layers.set(3);
    this.prompt.renderOrder = 10;
  }

  get items() { return this.pages[this.page]; }

  setPage(p) {
    this.page = p;
    this.sel = 0;
    this._draw(true);
  }

  toggle() {
    this.open = !this.open;
    this.mesh.visible = this.open;
    if (this.open) { this.page = 'main'; this.sel = 0; this._draw(true); }
  }

  // uv from the right-hand ray hitting the panel (or null): hovering selects
  pointAt(uv) {
    if (!uv) { this.hoverRow = -1; return; }
    const py = (1 - uv.y) * H;
    const r = Math.floor((py - (TOP - 30)) / ROW);
    this.hoverRow = r >= 0 && r < this.items.length ? r : -1;
    if (this.hoverRow >= 0) this.sel = this.hoverRow;
  }

  // right-trigger while pointing at the panel
  click() {
    if (!this.open) return;
    if (this.sel >= 0 && this.sel < this.items.length) this.items[this.sel].adjust(1);
  }

  // pads: Gamepad or null. Returns true while the menu owns right-hand input.
  update(leftPad, rightPad) {
    const lb = leftPad && leftPad.buttons;
    const menuBtn = !!(lb && lb[4] && lb[4].pressed); // X
    if (menuBtn && this._nav.menu) { this._nav.menu = false; this.toggle(); }
    if (!menuBtn) this._nav.menu = true;
    if (!this.open) return false;

    // stick up/down = rows, A/trigger = toggle. Left/right stays SNAP TURN
    // (menu deliberately does NOT own it - turning while a debug view is up
    // is how you actually inspect the scene)
    const ra = (rightPad && rightPad.axes) || [];
    const rb = rightPad && rightPad.buttons;
    const y = ra[3] || 0;
    if (Math.abs(y) > 0.6 && this._nav.y) {
      this._nav.y = false;
      this.sel = (this.sel + (y > 0 ? 1 : -1) + this.items.length) % this.items.length;
    }
    if (Math.abs(y) < 0.3) this._nav.y = true;
    const aBtn = !!(rb && rb[4] && rb[4].pressed); // A
    if (aBtn && this._nav.a) { this._nav.a = false; this.items[this.sel].adjust(1); }
    if (!aBtn) this._nav.a = true;
    this._draw();
    return true;
  }

  _draw(force = false) {
    const sig = this.page + '|' + this.sel + '|' + this.hoverRow + '|' +
      this.items.map(i => i.value()).join('|');
    if (!force && sig === this._sig) return;
    this._sig = sig;
    const ctx = this.canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(10,12,16,0.82)';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#8fb8ff';
    ctx.font = 'bold 30px system-ui';
    ctx.textAlign = 'left';
    ctx.fillText(this.page === 'main' ? 'PortalIBL' : 'PortalIBL · tuning', 20, 44);
    ctx.font = '21px system-ui';
    ctx.fillStyle = '#7a8699';
    ctx.fillText('point + trigger · stick: rows, A: toggle · X closes', 20, 76);
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      if (i === this.sel) {
        ctx.fillStyle = 'rgba(90,140,255,0.25)';
        ctx.fillRect(10, TOP + i * ROW - 30, W - 20, 40);
      }
      ctx.font = 'bold 26px system-ui';
      ctx.fillStyle = i === this.sel ? '#ffffff' : '#b7c2d3';
      ctx.textAlign = 'left';
      ctx.fillText(it.name, 24, TOP + i * ROW);
      ctx.textAlign = 'right';
      ctx.fillStyle = i === this.sel ? '#9fe0a8' : '#7fa886';
      ctx.fillText(it.value(), W - 24, TOP + i * ROW);
    }
    this.tex.needsUpdate = true;
  }
}
