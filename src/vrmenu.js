// In-VR debug menu: a canvas panel on the LEFT hand, toggled with X.
// Navigate with the RIGHT stick (up/down = row, left/right = adjust),
// A activates. While open, snap turn and the A rate-toggle are suppressed
// (the menu owns those inputs). A small always-on prompt under the left
// controller tells outsiders what the buttons do - unlabeled mystery
// buttons read as broken to anyone who isn't the developer.
import * as THREE from 'three';

const W = 512, H = 640;

export class VRMenu {
  // items: [{ name, value():string, adjust(dir) }] - adjust(+1/-1); buttons
  // ignore dir. Values re-render on change.
  constructor(items) {
    this.items = items;
    this.open = false;
    this.sel = 0;
    this._sig = '';
    this._nav = { x: true, y: true, a: true, menu: true }; // edge triggers

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

    // always-on hand prompt (the "how do I open the menu" label)
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

  toggle() {
    this.open = !this.open;
    this.mesh.visible = this.open;
    if (this.open) this._draw(true);
  }

  // leftPad/rightPad: Gamepad objects (or null). Returns true when the menu
  // consumed the right-hand inputs this frame (caller suppresses snap/rate).
  update(leftPad, rightPad) {
    const lb = leftPad && leftPad.buttons;
    const menuBtn = !!(lb && lb[4] && lb[4].pressed); // X
    if (menuBtn && this._nav.menu) { this._nav.menu = false; this.toggle(); }
    if (!menuBtn) this._nav.menu = true;
    if (!this.open) return false;

    const ra = (rightPad && rightPad.axes) || [];
    const rb = rightPad && rightPad.buttons;
    const x = ra[2] || 0, y = ra[3] || 0;
    if (Math.abs(y) > 0.6 && this._nav.y) {
      this._nav.y = false;
      this.sel = (this.sel + (y > 0 ? 1 : -1) + this.items.length) % this.items.length;
    }
    if (Math.abs(y) < 0.3) this._nav.y = true;
    if (Math.abs(x) > 0.6 && this._nav.x) {
      this._nav.x = false;
      this.items[this.sel].adjust(x > 0 ? 1 : -1);
    }
    if (Math.abs(x) < 0.3) this._nav.x = true;
    const aBtn = !!(rb && rb[4] && rb[4].pressed); // A
    if (aBtn && this._nav.a) { this._nav.a = false; this.items[this.sel].adjust(1); }
    if (!aBtn) this._nav.a = true;
    this._draw();
    return true;
  }

  _draw(force = false) {
    const sig = this.sel + '|' + this.items.map(i => i.value()).join('|');
    if (!force && sig === this._sig) return;
    this._sig = sig;
    const ctx = this.canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(10,12,16,0.82)';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#8fb8ff';
    ctx.font = 'bold 30px system-ui';
    ctx.textAlign = 'left';
    ctx.fillText('PortalGI debug', 20, 44);
    ctx.font = '22px system-ui';
    ctx.fillStyle = '#7a8699';
    ctx.fillText('stick: navigate / adjust · A: toggle · X: close', 20, 76);
    const row = 46, top = 110;
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      if (i === this.sel) {
        ctx.fillStyle = 'rgba(90,140,255,0.25)';
        ctx.fillRect(10, top + i * row - 30, W - 20, 40);
      }
      ctx.font = 'bold 26px system-ui';
      ctx.fillStyle = i === this.sel ? '#ffffff' : '#b7c2d3';
      ctx.textAlign = 'left';
      ctx.fillText(it.name, 24, top + i * row);
      ctx.textAlign = 'right';
      ctx.fillStyle = i === this.sel ? '#9fe0a8' : '#7fa886';
      ctx.fillText(it.value(), W - 24, top + i * row);
    }
    this.tex.needsUpdate = true;
  }
}
