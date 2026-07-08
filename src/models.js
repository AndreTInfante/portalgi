// Poly Haven glTF exhibits (CC0), loaded at 1k and shaded as dynamic PBR props:
// probe-grid diffuse + traversal specular (shader mode 4) with their real
// albedo/normal/ARM maps. Fully excluded from every bake (captures, BVH,
// lightmap) so carrying them around can never cause a mismatch.
import * as THREE from 'three';
import { GLTFLoader } from '../libs/loaders/GLTFLoader.js';
import { GeoBuilder } from './level.js';

// Scaled-up STATIC (non-carryable) exhibit copies: full members of the baked
// world - lightmap charts (their photoscan UVs are unique, so the whole mesh
// is one chart), the path tracer BVH (shadows + bounce), and the cubemap
// captures (reflections). This is the lightmapped-prop path.
export const STATIC_MODEL_DEFS = [
  { slug: 'horse_statue_01', size: 2.2, cell: 2, x: 0, z: 13.3, rotY: Math.PI },
  { slug: 'bronze_whale_statue', size: 2.4, cell: 8, x: 13.4, z: -15.8, rotY: Math.PI / 5 },
  // courtyard greenery (CC0): opposite corners, off the benches
  { slug: 'potted_plant_02', size: 1.15, cell: 13, x: 17.5, z: -3.6, rotY: 0.6 },
  { slug: 'potted_plant_04', size: 1.35, cell: 13, x: 23.7, z: 3.6, rotY: -1.1 },
];

export async function addStaticModels(level) {
  const loader = new GLTFLoader();
  let idx = 0;
  await Promise.all(STATIC_MODEL_DEFS.map(async def => {
    try {
      const gltf = await loader.loadAsync(`./assets/models/gltf/${def.slug}/${def.slug}_1k.gltf`);
      const box = new THREE.Box3().setFromObject(gltf.scene);
      const dim = box.getSize(new THREE.Vector3());
      const scale = def.size / Math.max(dim.x, dim.y, dim.z);
      const center = box.getCenter(new THREE.Vector3());
      const M = new THREE.Matrix4()
        .makeTranslation(def.x, 0, def.z)
        .multiply(new THREE.Matrix4().makeRotationY(def.rotY || 0))
        .multiply(new THREE.Matrix4().makeScale(scale, scale, scale))
        .multiply(new THREE.Matrix4().makeTranslation(-center.x, -box.min.y, -center.z));
      gltf.scene.updateMatrixWorld(true);
      const physPts = []; // subsampled WORLD verts -> physics band fit below
      gltf.scene.traverse(o => {
        if (!o.isMesh) return;
        if (!o.geometry.getAttribute('tangent')) {
          try { o.geometry.computeTangents(); } catch (e) {}
        }
        let g = o.geometry.clone();
        g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(M, o.matrixWorld));
        if (g.index) g = g.toNonIndexed();
        {
          const pa = g.getAttribute('position');
          const step = Math.max(1, Math.floor(pa.count / 600));
          for (let i = 0; i < pa.count; i += step) {
            physPts.push([pa.getX(i), pa.getY(i), pa.getZ(i)]);
          }
        }
        const gb = new GeoBuilder();
        gb.pos = Array.from(g.getAttribute('position').array);
        gb.nrm = Array.from(g.getAttribute('normal').array);
        gb.uv = Array.from(g.getAttribute('uv').array);
        const t = g.getAttribute('tangent');
        gb.tan = t ? Array.from(t.array) : new Array((gb.pos.length / 3) * 4).fill(0);
        const chartS = def.size * 1.6; // lightmap footprint in meters (density scaling)
        gb.lc = [];
        for (let k = 0; k < gb.uv.length; k += 2) {
          gb.lc.push(Math.min(Math.max(gb.uv[k], 0), 1) * chartS, Math.min(Math.max(gb.uv[k + 1], 0), 1) * chartS);
        }
        gb.charts = [{ w: chartS, h: chartS, start: 0, count: gb.pos.length / 3 }];
        const src = o.material;
        level.cells[def.cell].builders.set(`smodel${idx++}`, {
          geo: gb,
          opts: {
            texMap: src.map, texNrm: src.normalMap, texOrm: src.roughnessMap || src.metalnessMap,
            avg: [0.42, 0.4, 0.36], roughFactor: 1, slug: def.slug,
            // authored occluder capsules are in the grounded/unrotated local
            // frame; this is the transform back to world (see proxies.js)
            proxyFrame: { x: def.x, z: def.z, rotY: def.rotY || 0 },
          },
        });
      });
      // physics spheres: vertical band fit over the REAL world vertices
      // (centroid + 90th-percentile radius per band). The authored occluder
      // capsules are tuned for reflection blobs, not contact, so they can't
      // be reused for collision.
      const physSpheres = [];
      if (physPts.length > 12) {
        let minY = Infinity, maxY = -Infinity;
        for (const p of physPts) { if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1]; }
        const K = 4;
        for (let b = 0; b < K; b++) {
          const lo = minY + ((maxY - minY) * b) / K;
          const hi = minY + ((maxY - minY) * (b + 1)) / K;
          const band = physPts.filter(p => p[1] >= lo && p[1] <= hi);
          if (band.length < 8) continue;
          const c = [0, 0, 0];
          for (const p of band) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
          c[0] /= band.length; c[1] /= band.length; c[2] /= band.length;
          const ds = band.map(p => Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2])).sort((a, b2) => a - b2);
          physSpheres.push([c[0], c[1], c[2], Math.max(ds[Math.floor(ds.length * 0.9)], 0.12)]);
        }
      }
      // r: generous player-collision radius (can't clip the statue overhang);
      // rx/rz: reflection-contact footprint = the plinth, NOT the collision r.
      // physPts: the raw world-space samples - physics.js hulls them at a
      // 50-vert budget; the band spheres survive only as a hull-failure
      // fallback.
      level.colliders.push({
        x: def.x, z: def.z, r: def.size * 0.42,
        rx: def.size * 0.25, rz: def.size * 0.25, rot: 0,
        physSpheres, physPts,
      });
    } catch (e) {
      console.error(`static model failed: ${def.slug}`, e);
    }
  }));
}

export const MODEL_DEFS = [
  // horse + elephant on the gallery pedestals - spreads dynamic props across rooms
  { slug: 'horse_statue_01', size: 0.85, cell: 0, x: 0, z: -1.4, ped: true },
  { slug: 'carved_wooden_elephant', size: 0.62, cell: 0, x: 2.5, z: -1.4, ped: true },
  // boxFit: the pan's real-mesh hull hugs the thin disc + handle and reads
  // wrong on contact, so collide it as a fitted box instead. collInflate grows
  // that box 20% for a more forgiving grab (set to 1 for a snug box).
  { slug: 'brass_pan_01', size: 0.5, cell: 10, x: -2.4, z: 24.7, ped: true, boxFit: true, collInflate: 1.2 },
  { slug: 'bronze_whale_statue', size: 1.15, cell: 11, x: 6.6, z: 22.5 },
  // specBoost consumes the fan's KHR_materials_specular map, which our shader
  // has no per-texel channel for: it's a near-uniform ~0.5 spec-intensity mask
  // (mean 0.50, stddev 0.02), so the scalar is faithful. Without it the fan's
  // dielectric parts render at full F0=0.04 and read too glossy.
  { slug: 'ceiling_fan', size: 1.0, cell: 10, x: 1.8, z: 24, hangCeil: 4.0, specBoost: 0.5 },
  { slug: 'CoffeeCart_01', size: 1.4, cell: 10, x: -2.4, z: 25.6, rotY: Math.PI },
  // chairs face the room center; specBoost 0.8 trims 20% off their reflections
  // (the ARM roughness reads glossier than upholstery/wood should on-device)
  { slug: 'BarberShopChair_01', size: 1.15, cell: 12, x: -9.3, z: 24.2, rotY: Math.PI * 0.75, specBoost: 0.8 },
  { slug: 'mid_century_lounge_chair', size: 0.95, cell: 12, x: -4.8, z: 22.5, rotY: -Math.PI / 2, specBoost: 0.8 },
  { slug: 'modern_arm_chair_01', size: 0.95, cell: 12, x: -9.3, z: 20.8, rotY: Math.PI / 4, specBoost: 0.8 },
  { slug: 'ClassicConsole_01', size: 1.35, cell: 12, x: -7.1, z: 24.55 },
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
        o.layers.set(3); // dynamic: never in cubemap captures (1/2 = XR eyes)
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
          specBoost: def.specBoost, // per-prop spec trim (fan KHR map / chair fudge); undefined -> 1
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
      out.push({ root, mats, radius, rFloor, cell: def.cell, slug: def.slug, boxFit: def.boxFit, collInflate: def.collInflate });
    } catch (e) {
      console.error(`model load failed: ${def.slug}`, e);
    }
  }));
  return out;
}
