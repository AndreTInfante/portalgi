// Touch controls for phones/tablets: a floating joystick on the left half
// moves (writes player.moveAxis), drags on the right half look, and a quick
// tap raycasts - tap a prop to pick it up, tap again to drop it. Desktop
// mouse/keyboard is untouched; this only attaches on coarse-pointer devices.
import * as THREE from 'three';

export function isTouchDevice() {
  return matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
}

const JOY_RADIUS = 55;   // px; nub clamp = full deflection
const TAP_MS = 250;
const TAP_SLOP = 14;     // px of movement that still counts as a tap

export class TouchControls {
  constructor(player, props, camera, dom) {
    this.player = player;
    this.props = props;
    this.camera = camera;
    this.joy = null;  // { id, ox, oy } active joystick touch
    this.look = null; // { id, x, y, t0, moved } active look/tap touch
    this.base = document.getElementById('joy-base');
    this.nub = document.getElementById('joy-nub');
    document.getElementById('touch-help').classList.remove('hidden');
    player.moveAxis = { x: 0, y: 0 };
    dom.addEventListener('touchstart', e => this.onStart(e), { passive: false });
    dom.addEventListener('touchmove', e => this.onMove(e), { passive: false });
    dom.addEventListener('touchend', e => this.onEnd(e), { passive: false });
    dom.addEventListener('touchcancel', e => this.onEnd(e), { passive: false });
  }

  onStart(e) {
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (t.clientX < innerWidth * 0.4 && !this.joy) {
        this.joy = { id: t.identifier, ox: t.clientX, oy: t.clientY };
        this.base.classList.remove('hidden');
        this.nub.classList.remove('hidden');
        this.placeJoy(t.clientX, t.clientY);
      } else if (!this.look) {
        this.look = { id: t.identifier, x: t.clientX, y: t.clientY, t0: performance.now(), moved: 0 };
      }
    }
  }

  onMove(e) {
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (this.joy && t.identifier === this.joy.id) {
        let dx = t.clientX - this.joy.ox, dy = t.clientY - this.joy.oy;
        const len = Math.hypot(dx, dy);
        if (len > JOY_RADIUS) { dx *= JOY_RADIUS / len; dy *= JOY_RADIUS / len; }
        this.player.moveAxis.x = dx / JOY_RADIUS;
        this.player.moveAxis.y = -dy / JOY_RADIUS; // screen-up = forward
        this.placeJoy(this.joy.ox + dx, this.joy.oy + dy);
      } else if (this.look && t.identifier === this.look.id) {
        const dx = t.clientX - this.look.x, dy = t.clientY - this.look.y;
        this.look.x = t.clientX; this.look.y = t.clientY;
        this.look.moved += Math.abs(dx) + Math.abs(dy);
        this.player.yaw -= dx * 0.006;
        this.player.pitch = Math.max(-1.5, Math.min(1.5, this.player.pitch - dy * 0.006));
      }
    }
  }

  onEnd(e) {
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (this.joy && t.identifier === this.joy.id) {
        this.joy = null;
        this.player.moveAxis.x = 0;
        this.player.moveAxis.y = 0;
        this.base.classList.add('hidden');
        this.nub.classList.add('hidden');
      } else if (this.look && t.identifier === this.look.id) {
        const quick = performance.now() - this.look.t0 < TAP_MS && this.look.moved < TAP_SLOP;
        if (quick) this.tap(t.clientX, t.clientY);
        this.look = null;
      }
    }
  }

  placeJoy(nx, ny) {
    this.base.style.left = `${this.joy.ox}px`;
    this.base.style.top = `${this.joy.oy}px`;
    this.nub.style.left = `${nx}px`;
    this.nub.style.top = `${ny}px`;
  }

  tap(cx, cy) {
    if (this.props.held) { this.props.dropHeld(); return; }
    // ray through the tapped pixel; same reach as the desktop crosshair grab
    const ndc = new THREE.Vector2((cx / innerWidth) * 2 - 1, -(cy / innerHeight) * 2 + 1);
    const dir = new THREE.Vector3(ndc.x, ndc.y, 0.5).unproject(this.camera)
      .sub(this.camera.position).normalize();
    const p = this.props.aim(this.player.pos, dir);
    if (p) this.props.grab(p);
  }
}
