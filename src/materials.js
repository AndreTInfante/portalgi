// Material factory: every scene surface uses one shader program (sceneFrag)
// parameterized per cell/material. Global uniforms are shared BY IDENTITY across
// all materials, so flipping e.g. uMaxSteps.value updates the whole scene.
import * as THREE from 'three';
import { SCENE_VERT, sceneFrag } from './shaders.js';
import { buildOccluderGroup } from './occluders.js';

// hull records as a std140 uniform block: the traversal's dependent
// texelFetches become constant-register reads. Flip false to fall back to
// the DataTexture path (same GLSL interface) if a driver misbehaves.
const USE_HULL_UBO = true;

export function createMaterialSystem(level, textures, hullTex, atlasTex) {
  const numCells = level.cells.length;
  const frag = sceneFrag(numCells, USE_HULL_UBO);

  let hullGroup = null;
  if (USE_HULL_UBO) {
    // one Uniform per vec4 slot: r160's UniformsGroup change-cache can't
    // handle a single array-valued uniform (value.clone() on a plain Array),
    // and the std140 layout is byte-identical either way
    hullGroup = new THREE.UniformsGroup();
    hullGroup.setName('HullData');
    hullGroup.setUsage(THREE.StaticDrawUsage);
    const a = hullTex.userData.array;
    for (let i = 0; i < a.length; i += 4) {
      hullGroup.add(new THREE.Uniform(new THREE.Vector4(a[i], a[i + 1], a[i + 2], a[i + 3])));
    }
  }
  // analytic occluder block (filled per frame by OccluderSystem); UBO-only
  const occ = USE_HULL_UBO ? buildOccluderGroup(numCells) : null;

  // defaults from interactive tuning: virtual portals ignore the edge blend in
  // the shader, so modest blend widths here only affect doorways
  const blackTex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  blackTex.needsUpdate = true;
  const flatNrm = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1);
  flatNrm.needsUpdate = true;
  const flatOrm = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  flatOrm.needsUpdate = true; // AO=1, rough=1-factor, metal=1-factor

  const globals = {
    uAtlas: { value: atlasTex },
    uHullTex: { value: hullTex },
    uLightmap: { value: blackTex }, // swapped in once the path-traced bake lands
    uUseLightmap: { value: 0.0 },
    uMaxSteps: { value: 3 },
    uRoughHops: { value: 1.0 },
    uBlendOn: { value: 1.0 },
    uBlendBase: { value: 0.04 },
    uBlendRough: { value: 1.0 }, // ~cone footprint radius per (roughness - meter); silhouette edges only
    uDistRough: { value: 0.12 },
    uIrrBlend: { value: 3.0 },
    uBake: { value: 0.0 },
    uExposure: { value: 0.3 },
    uDebugMode: { value: 0 },
    uOccOn: { value: 1.0 },      // analytic occluders: DEFAULT after the 2026-07-03
                                 // A/B (0.23ms vs 2.1ms for planar smudges, worst view)
    uOccHops: { value: 1 },     // hop-2 occlusion measured ~0.9ms for through-
                                // doorway blobs only (GUI dial to restore)
    uOccDensity: { value: 1.2 },
    uOccWiden: { value: 0.5 },   // cone growth per rough-meter: drives spread AND fade
    uOccTint: { value: 0.8 },    // user-tuned: it's ~AO + optically-correct ambient
  };

  function lightUniforms(cellId) {
    const cell = level.cells[cellId];
    const lp = [], lc = [];
    for (let i = 0; i < 8; i++) {
      const l = cell.lights[i];
      lp.push(new THREE.Vector3(...(l ? l.pos : [0, 0, 0])));
      lc.push(l ? new THREE.Vector3(l.color[0] * l.intensity, l.color[1] * l.intensity, l.color[2] * l.intensity)
                : new THREE.Vector3());
    }
    return { lp, lc, n: Math.min(cell.lights.length, 8) };
  }

  const allMaterials = [];
  function makeMaterial(cellId, opts = {}) {
    const { lp, lc, n } = lightUniforms(cellId);
    const mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: SCENE_VERT,
      fragmentShader: frag,
      // FrontSide: winding is normal-oriented at emit time; DoubleSide was a
      // crutch that doubled binning/hidden-surface work on tiled GPUs (Tier 1)
      side: THREE.FrontSide,
      uniforms: {
        ...globals, // shared identity - do not clone
        uMap: { value: opts.map || textures.white.map },
        uNrmMap: { value: opts.nrm || flatNrm },
        uOrmMap: { value: opts.orm || flatOrm },
        uCell: { value: cellId },
        uCellPrev: { value: -1 },
        uPrevMix: { value: 0.0 },
        uMode: { value: opts.mode || 0 },
        uTint: { value: new THREE.Vector3(...(opts.tint || [1, 1, 1])) },
        uEmissive: { value: new THREE.Vector3(...(opts.emissive || [0, 0, 0])) },
        uRough: { value: opts.rough !== undefined ? opts.rough : 0.04 }, // glass/pane only
        uOccSelf: { value: -1 }, // occluder id of THIS prop (self-occlusion skip)
        uRoughFactor: { value: opts.roughFactor !== undefined ? opts.roughFactor : 1 },
        uMetalFactor: { value: opts.metalFactor !== undefined ? opts.metalFactor : 0 },
        // artistic clear-coat cheat: dielectric F0=0.04 spec reads as nothing
        // on a bright floor - polished stone needs help to read as polished
        uSpecBoost: { value: opts.specBoost !== undefined ? opts.specBoost : 1 },
        uLightPos: { value: lp },
        uLightColor: { value: lc },
        uLightCount: { value: n },
      },
    });
    if (hullGroup) mat.uniformsGroups = occ ? [hullGroup, occ.group] : [hullGroup];
    allMaterials.push(mat);
    return mat;
  }

  // Props take NO analytic lights. Specular continuity across a cell handoff
  // is inherent (coincident portals + traversal); diffuse crossfades from the
  // previous cell's irradiance over ~0.2s (decayed each frame by the caller).
  function setMaterialCell(mat, cellId) {
    const cur = mat.uniforms.uCell.value;
    if (cur === cellId) return;
    mat.uniforms.uCellPrev.value = cur;
    mat.uniforms.uPrevMix.value = 1.0;
    mat.uniforms.uCell.value = cellId;
  }

  return { globals, makeMaterial, setMaterialCell, allMaterials, occ };
}

// Instantiate all static level meshes into the scene (layer 0 = baked/static).
// Everything static - including paintings, frames, and emissive panels - comes
// through the chart-aware builders, so it all has lightmap UVs and one path.
export function buildStaticMeshes(scene, level, matsys, textures, paintingTexs) {
  const group = new THREE.Group();
  for (const cell of level.cells) {
    for (const [key, b] of cell.builders) {
      if (b.geo.empty) continue;
      const o = b.opts || {};
      const set = o.texMap ? { map: o.texMap, normalMap: o.texNrm, ormMap: o.texOrm }
        : o.paintingIndex !== undefined
          ? { map: paintingTexs[o.paintingIndex] } // varnished canvas: flat maps, glossy factor
          : textures[o.mapKey || 'white'];
      const mesh = new THREE.Mesh(b.geo.buildGeometry(), matsys.makeMaterial(cell.id, {
        map: set.map, nrm: set.normalMap, orm: set.ormMap,
        roughFactor: o.paintingIndex !== undefined ? 0.4 : (o.roughFactor !== undefined ? o.roughFactor : 1),
        metalFactor: o.metalFactor !== undefined ? o.metalFactor : (o.texMap ? 1 : 0),
        specBoost: o.specBoost, tint: o.tint, emissive: o.emissive,
      }));
      mesh.name = `${cell.name}:${key}`;
      mesh.userData.cell = cell.id; // portal-visibility culling key
      group.add(mesh);
    }
  }
  scene.add(group);
  return group;
}
