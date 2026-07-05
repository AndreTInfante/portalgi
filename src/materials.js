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
  // one pruned program per material mode (statics carry no probe code, props
  // no lightmap code, glass/pane almost nothing) - the single uber-program
  // capped wave occupancy at a measured 52%
  const fragByMode = {};
  // debug variants compile in the traversal step accumulator + debug views;
  // shipping programs carry none of that register pressure
  let debugCompiled = false;
  const fragFor = (m, dbg = debugCompiled, matte = false) => {
    const k = m + (dbg ? 'd' : '') + (matte ? 'm' : '');
    return fragByMode[k] || (fragByMode[k] = sceneFrag(numCells, USE_HULL_UBO, m, dbg, matte));
  };

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
    uBlendBase: { value: 0.0 }, // sharp reflections get zero-width blend
                                // (cone footprint is 0; the old 0.04 floor
                                // over-blurred portals - user-tuned 2026-07-04)
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
    uOccDensity: { value: 1.6 },  // user-tuned 2026-07-04
    uOccWiden: { value: 1.5 },    // user-tuned 2026-07-04   // cone growth per rough-meter: drives spread AND fade
    uOccTint: { value: 0.8 },    // user-tuned: it's ~AO + optically-correct ambient
    uOccAO: { value: 0.8 },      // contact-AO strength from the same capsules
    uOccAOClamp: { value: 0.03 }, // AO min-distance clamp (m), artist dial
    uOccShadow: { value: 0.85 }, // dynamic capsule shadow-ray strength
    uOccBudget: { value: 16 },   // shared dyn capsule budget (AO/shadows/refl), closest-first
    uOccRange: { value: 10 },    // dyn effects radius around the viewer (2m feather)
  };

  function lightUniforms(cellId) {
    const cell = level.cells[cellId];
    const lp = [], lc = [], ld = [];
    for (let i = 0; i < 8; i++) {
      const l = cell.lights[i];
      lp.push(new THREE.Vector3(...(l ? l.pos : [0, 0, 0])));
      lc.push(l ? new THREE.Vector3(l.color[0] * l.intensity, l.color[1] * l.intensity, l.color[2] * l.intensity)
                : new THREE.Vector3());
      // spot axis + cos(outer); w = -2 marks a point light (props skip those:
      // their energy is already averaged into the probes)
      if (l && l.dir) {
        const d = new THREE.Vector3(...l.dir).normalize();
        ld.push(new THREE.Vector4(d.x, d.y, d.z, Math.cos((l.cone || 35) * Math.PI / 180)));
      } else {
        ld.push(new THREE.Vector4(0, -1, 0, -2));
      }
    }
    return { lp, lc, ld, n: Math.min(cell.lights.length, 8) };
  }

  const allMaterials = [];
  function makeMaterial(cellId, opts = {}) {
    const { lp, lc, ld, n } = lightUniforms(cellId);
    const mode = opts.mode || 0;
    const mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: SCENE_VERT,
      fragmentShader: fragFor(mode, debugCompiled, !!opts.matte),
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
        uLightDir: { value: ld },
        uLightCount: { value: n },
      },
    });
    if (hullGroup) mat.uniformsGroups = occ ? [hullGroup, occ.group] : [hullGroup];
    mat.userData.mode = mode;
    mat.userData.matte = !!opts.matte;
    // statics boot with the pre-lightmap fallback compiled in; setUseLightmap
    // strips it (and its register pressure) once the lightmap exists
    if (mode === 0 && !lightmapOn) mat.defines = { LM_FALLBACK: '' };
    allMaterials.push(mat);
    return mat;
  }

  // couples the lightmap uniform with the statics' LM_FALLBACK define: the
  // fallback path (analytic lights + blendedIrr) only exists in the compiled
  // program while it can actually be taken
  let lightmapOn = false;
  function setUseLightmap(on) {
    if (on === lightmapOn) return;
    lightmapOn = on;
    globals.uUseLightmap.value = on ? 1.0 : 0.0;
    for (const m of allMaterials) {
      if (m.userData.mode !== 0) continue;
      if (on) delete m.defines.LM_FALLBACK;
      else (m.defines || (m.defines = {})).LM_FALLBACK = '';
      m.needsUpdate = true;
    }
  }

  // Props take NO analytic lights. Specular continuity across a cell handoff
  // is inherent (coincident portals + traversal); diffuse crossfades from the
  // previous cell's irradiance over ~0.2s (decayed each frame by the caller).
  // swap every material between shipping and debug-instrumented programs
  // (same pattern as setUseLightmap: a rebuild hitch when toggling the GUI
  // view is the price of debug-free shipping programs)
  function setDebugCompiled(on) {
    if (on === debugCompiled) return;
    debugCompiled = on;
    for (const m of allMaterials) {
      m.fragmentShader = fragFor(m.userData.mode, on, m.userData.matte);
      m.needsUpdate = true;
    }
  }

  function setMaterialCell(mat, cellId) {
    const cur = mat.uniforms.uCell.value;
    if (cur === cellId) return;
    mat.uniforms.uCellPrev.value = cur;
    mat.uniforms.uPrevMix.value = 1.0;
    mat.uniforms.uCell.value = cellId;
    // props evaluate the local SPOT lights analytically (probes can't carry a
    // narrow beam) - the light set must follow the prop across cells
    const { lp, lc, ld, n } = lightUniforms(cellId);
    mat.uniforms.uLightPos.value = lp;
    mat.uniforms.uLightColor.value = lc;
    mat.uniforms.uLightDir.value = ld;
    mat.uniforms.uLightCount.value = n;
  }

  return { globals, makeMaterial, setMaterialCell, setUseLightmap, setDebugCompiled, allMaterials, occ };
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
      const rf = o.paintingIndex !== undefined ? 0.4 : (o.roughFactor !== undefined ? o.roughFactor : 1);
      // MATTE eligibility: the set's guaranteed-minimum roughness (tracked on
      // canvas-processed ORM maps; gltf textures have no minG and stay full)
      // times the factor must clear the 0.65 irradiance early-out for EVERY
      // possible pixel - then the program compiles with no traversal at all
      const minG = set.ormMap && set.ormMap.userData && set.ormMap.userData.minG !== undefined
        ? set.ormMap.userData.minG : 0;
      const mesh = new THREE.Mesh(b.geo.buildGeometry(), matsys.makeMaterial(cell.id, {
        map: set.map, nrm: set.normalMap, orm: set.ormMap,
        roughFactor: rf,
        metalFactor: o.metalFactor !== undefined ? o.metalFactor : (o.texMap ? 1 : 0),
        specBoost: o.specBoost, tint: o.tint, emissive: o.emissive,
        matte: minG * rf > 0.65,
      }));
      mesh.name = `${cell.name}:${key}`;
      mesh.userData.cell = cell.id; // portal-visibility culling key
      if (o.slug) mesh.userData.slug = o.slug; // authored occluder proxy key
      if (o.proxyFrame) mesh.userData.proxyFrame = o.proxyFrame;
      group.add(mesh);
    }
  }
  scene.add(group);
  return group;
}
