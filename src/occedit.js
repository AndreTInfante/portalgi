// In-app occluder capsule editor (?occedit=1). Renders the selected entry's
// capsules as wireframes over the mesh, exposes each capsule's endpoints and
// radius as draggable GUI numbers, and dumps every touched set as JSON to
// paste into proxies.js. Statics edit WORLD coords; props edit PROP-LOCAL
// (the wireframes follow the prop's live transform either way).
import * as THREE from 'three';
import { MAX_SPH_PER_PROP } from './occluders.js';

const WIRE_MAT = new THREE.MeshBasicMaterial({
  color: 0x44ff88, wireframe: true, transparent: true, opacity: 0.55, depthTest: false,
});

export class OccluderEditor {
  constructor(scene, occluders) {
    this.occ = occluders;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.helpers = []; // per capsule slot: cylinder body + two sphere caps
    const mk = geo => {
      const m = new THREE.Mesh(geo, WIRE_MAT);
      m.matrixAutoUpdate = false;
      m.layers.set(3);
      m.renderOrder = 20;
      m.visible = false;
      this.group.add(m);
      return m;
    };
    for (let i = 0; i < MAX_SPH_PER_PROP; i++) {
      this.helpers.push({
        cyl: mk(new THREE.CylinderGeometry(1, 1, 1, 10, 1, true)),
        sa: mk(new THREE.SphereGeometry(1, 10, 6)),
        sb: mk(new THREE.SphereGeometry(1, 10, 6)),
      });
    }
    // selectables: props by slug/shape, statics by slug
    this.items = [];
    for (const e of occluders.entries) {
      this.items.push({ label: `prop: ${e.p.slug || e.p.mesh.name || 'primitive'}`, kind: 'prop', e });
    }
    occluders.statics.forEach((s, i) => {
      this.items.push({ label: `static: ${s.slug || 'furniture-' + i}`, kind: 'static', s });
    });
    this.sel = 0;
    this.touched = new Set();
    this._v = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._up = new THREE.Vector3(0, 1, 0);
  }

  // capsule accessor in the item's AUTHORING space (prop-local or world)
  _caps(item) {
    if (item.kind === 'prop') return item.e.spheres.map(s => ({
      get: () => [[s.a.x, s.a.y, s.a.z], [s.b.x, s.b.y, s.b.z], s.r],
      set: (f, v) => { // f in ax..az,bx..bz,r
        if (f === 'r') s.r = v;
        else (f[0] === 'a' ? s.a : s.b)[f[1]] = v;
      },
    }));
    return item.s.world.map(w => ({
      get: () => [[w[0].x, w[0].y, w[0].z], [w[1].x, w[1].y, w[1].z], w[0].w],
      set: (f, v) => {
        if (f === 'r') w[0].w = v;
        else w[f[0] === 'a' ? 0 : 1][f[1]] = v;
      },
    }));
  }

  attachGui(gui) {
    this.folder = gui.addFolder('Occluder editor');
    this.folder.add({ i: 0 }, 'i', Object.fromEntries(this.items.map((it, i) => [it.label, i])))
      .name('entry').onChange(v => { this.sel = v; this._rebuildCapsuleGui(); });
    this.capFolder = null;
    this.folder.add({ dump: () => this.dump() }, 'dump').name('DUMP proxies.js JSON');
    this._rebuildCapsuleGui();
  }

  _rebuildCapsuleGui() {
    if (this.capFolder) this.capFolder.destroy();
    this.capFolder = this.folder.addFolder('capsules');
    const item = this.items[this.sel];
    const caps = this._caps(item);
    caps.forEach((c, i) => {
      const [a, b, r] = c.get();
      const o = {
        ax: a[0], ay: a[1], az: a[2], bx: b[0], by: b[1], bz: b[2], r,
      };
      const f = this.capFolder.addFolder(`capsule ${i}`);
      for (const k of ['ax', 'ay', 'az', 'bx', 'by', 'bz']) {
        f.add(o, k).step(0.01).onChange(v => { c.set(k, v); this._mark(item); });
      }
      f.add(o, 'r', 0.02, 1.5, 0.01).onChange(v => { c.set('r', v); this._mark(item); });
      f.close();
    });
    this.capFolder.add({ add: () => { this._addCapsule(item); this._rebuildCapsuleGui(); } }, 'add')
      .name('+ capsule (dup last)');
    this.capFolder.add({ del: () => { this._delCapsule(item); this._rebuildCapsuleGui(); } }, 'del')
      .name('- capsule (drop last)');
  }

  _mark(item) { this.touched.add(item); }

  _addCapsule(item) {
    if (item.kind === 'prop') {
      const list = item.e.spheres;
      if (list.length >= MAX_SPH_PER_PROP) return;
      const last = list[list.length - 1];
      list.push({ a: last.a.clone(), b: last.b.clone().addScalar(0.1), r: last.r });
      item.e.world.push([new THREE.Vector4(), new THREE.Vector4()]);
    } else {
      const list = item.s.world;
      if (list.length >= MAX_SPH_PER_PROP) return;
      const last = list[list.length - 1];
      list.push([last[0].clone().add(new THREE.Vector4(0.1, 0.1, 0, 0)), last[1].clone()]);
    }
    this._mark(item);
  }

  _delCapsule(item) {
    if (item.kind === 'prop') {
      if (item.e.spheres.length > 1) { item.e.spheres.pop(); item.e.world.pop(); this._mark(item); }
    } else if (item.s.world.length > 1) { item.s.world.pop(); this._mark(item); }
  }

  dump() {
    const out = { statics: {}, props: {} };
    for (const item of this.touched) {
      const caps = this._caps(item).map(c => {
        const [a, b, r] = c.get();
        const rnd = v => v.map(x => Math.round(x * 1000) / 1000);
        return [rnd(a), rnd(b), Math.round(r * 1000) / 1000];
      });
      if (item.kind === 'prop' && item.e.p.slug) out.props[item.e.p.slug] = caps;
      else if (item.kind === 'static') out.statics[item.s.slug || item.label] = caps;
    }
    const j = JSON.stringify(out, null, 2);
    console.log('occluder proxies:', j);
    if (navigator.clipboard) navigator.clipboard.writeText(j).catch(() => {});
    return j;
  }

  // position the wireframes over the selected entry's capsules (world space)
  updateFrame() {
    const item = this.items[this.sel];
    const worldCaps = item.kind === 'prop'
      ? item.e.spheres.map(s => {
        const mw = item.e.p.mesh.matrixWorld;
        const sc = mw.getMaxScaleOnAxis();
        return {
          a: this._v.copy(s.a).applyMatrix4(mw).clone(),
          b: new THREE.Vector3().copy(s.b).applyMatrix4(mw),
          r: s.r * sc,
        };
      })
      : item.s.world.map(w => ({
        a: new THREE.Vector3(w[0].x, w[0].y, w[0].z),
        b: new THREE.Vector3(w[1].x, w[1].y, w[1].z),
        r: w[0].w,
      }));
    const IQ = new THREE.Quaternion();
    for (let i = 0; i < this.helpers.length; i++) {
      const h = this.helpers[i];
      const c = worldCaps[i];
      h.cyl.visible = h.sa.visible = h.sb.visible = !!c;
      if (!c) continue;
      const mid = new THREE.Vector3().addVectors(c.a, c.b).multiplyScalar(0.5);
      const dir = new THREE.Vector3().subVectors(c.b, c.a);
      const len = Math.max(dir.length(), 1e-4);
      this._q.setFromUnitVectors(this._up, dir.normalize());
      h.cyl.matrix.compose(mid, this._q, new THREE.Vector3(c.r, len, c.r));
      h.sa.matrix.compose(c.a, IQ, new THREE.Vector3(c.r, c.r, c.r));
      h.sb.matrix.compose(c.b, IQ, new THREE.Vector3(c.r, c.r, c.r));
    }
  }
}
