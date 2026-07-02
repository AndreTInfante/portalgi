// Poly Haven glTF exhibits (CC0), loaded at 1k and shaded as dynamic PBR props:
// probe-grid diffuse + traversal specular (shader mode 4) with their real
// albedo/normal/ARM maps. Fully excluded from every bake (captures, BVH,
// lightmap) so carrying them around can never cause a mismatch.
import * as THREE from 'three';
import { GLTFLoader } from '../libs/loaders/GLTFLoader.js';

const MODEL_DEFS = [
  { slug: 'horse_statue_01', size: 0.85, cell: 10, x: -1.8, z: 21, ped: true },
  { slug: 'carved_wooden_elephant', size: 0.62, cell: 10, x: 1.8, z: 21, ped: true },
  { slug: 'brass_pan_01', size: 0.5, cell: 10, x: -1.8, z: 24, ped: true },
  { slug: 'bronze_whale_statue', size: 1.15, cell: 11, x: 6.6, z: 22.5 },
  { slug: 'ceiling_fan', size: 1.0, cell: 10, x: 1.8, z: 24, hangCeil: 4.0 },
  { slug: 'CoffeeCart_01', size: 1.4, cell: 10, x: -2.4, z: 25.6, rotY: Math.PI },
  { slug: 'BarberShopChair_01', size: 1.15, cell: 12, x: -9.3, z: 24.2 },
  { slug: 'mid_century_lounge_chair', size: 0.95, cell: 12, x: -4.8, z: 22.5 },
  { slug: 'modern_arm_chair_01', size: 0.95, cell: 12, x: -9.3, z: 20.8 },
  { slug: 'ClassicConsole_01', size: 1.35, cell: 12, x: -7.1, z: 24.55 },
  { slug: 'ornate_mirror_01', size: 1.2, cell: 12, x: -10.32, z: 22.5, rotY: Math.PI / 2, yCenter: 1.6 },
];

export async function loadModelProps(matsys, manager) {
  const loader = new GLTFLoader(manager);
  const out = [];
  await Promise.all(MODEL_DEFS.map(async def => {
    try {
      const gltf = await loader.loadAsync(`./assets/models/gltf/${def.slug}/${def.slug}_1k.gltf`);
      const inner = gltf.scene;
      const box = new THREE.Box3().setFromObject(inner);
      const dim = box.getSize(new THREE.Vector3());
      const scale = def.size / Math.max(dim.x, dim.y, dim.z);
      inner.scale.setScalar(scale);
      box.setFromObject(inner);
      const center = box.getCenter(new THREE.Vector3());
      const root = new THREE.Group();
      inner.position.sub(center); // prop origin = bbox center (physics sphere center)
      root.add(inner);
      const mats = [];
      root.traverse(o => {
        if (!o.isMesh) return;
        o.layers.set(1); // dynamic: never in cubemap captures
        const g = o.geometry;
        if (!g.getAttribute('tangent')) {
          try { g.computeTangents(); } catch (e) { /* non-indexed or no uv - flat tangent */ }
        }
        const t = g.getAttribute('tangent');
        if (t) g.setAttribute('tang4', t);
        const src = o.material;
        const mat = matsys.makeMaterial(def.cell, {
          mode: 4,
          map: src.map, nrm: src.normalMap, orm: src.roughnessMap || src.metalnessMap,
          roughFactor: 1, metalFactor: 1,
        });
        o.material = mat;
        mats.push(mat);
      });
      const radius = Math.max(dim.x, dim.z) * scale * 0.5;
      const rFloor = center.y - box.min.y; // rest height of the origin above ground
      if (def.rotY) root.rotation.y = def.rotY;
      let y = (def.ped ? 1.0 : 0) + rFloor;
      if (def.hangCeil !== undefined) y = def.hangCeil - (box.max.y - center.y) - 0.02;
      if (def.yCenter !== undefined) y = def.yCenter;
      root.position.set(def.x, y, def.z);
      out.push({ root, mats, radius, rFloor, cell: def.cell });
    } catch (e) {
      console.error(`model load failed: ${def.slug}`, e);
    }
  }));
  return out;
}
