// Bake pipeline: per-cell HDR cubemap capture -> octahedral atlas lod0 ->
// progressive angular prefilter for the mip column -> cosine-convolved
// irradiance tile. Runs as a generator so the caller can spread work across
// frames and show progress. Repeat iterations = light bounces (the scene is
// re-captured while sampling the previous atlas - the structure relights itself).
import * as THREE from 'three';
import {
  LOD_SIZES, LOD_X, N_LODS, IRR_X, IRR_SIZE, ROW_H, BORDER, ATLAS_W, atlasHeight,
  PROBE_X, PROBE_TILE, PROBES_PER_ROW, MAX_PROBES,
} from './atlas.js';
import { FS_TRI_VERT, cubeToOctFrag, filterFrag, irrFrag, probeFrag, COPY_FRAG } from './shaders.js';


export class Baker {
  constructor(renderer, level, hullTex) {
    this.renderer = renderer;
    this.level = level;
    const n = level.cells.length;

    const rtOpts = {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
      depthBuffer: false,
      stencilBuffer: false,
    };
    this.atlasA = new THREE.WebGLRenderTarget(ATLAS_W, atlasHeight(n), rtOpts);
    this.atlasB = new THREE.WebGLRenderTarget(ATLAS_W, atlasHeight(n), rtOpts);

    // 1024 cube capture feeds the 512px oct LOD0 with 2x linear headroom so
    // the cubeToOctFrag supersample genuinely box-filters (each oct texel
    // averages ~2x2 cube texels) rather than point-sampling a same-res cube
    this.cubeRT = new THREE.WebGLCubeRenderTarget(1024, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
    });
    this.cubeCam = new THREE.CubeCamera(0.05, 80, this.cubeRT);

    // fullscreen-triangle pass scene
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 3, -1, -1, 3], 2));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 10); // itemSize 2 breaks auto-compute
    this.quad = new THREE.Mesh(geo);
    this.quad.frustumCulled = false;
    this.fsScene = new THREE.Scene();
    this.fsScene.add(this.quad);
    this.fsCam = new THREE.Camera();

    const raw = (frag, uniforms) => new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, // three emits '#version 300 es' first, before its defines
      vertexShader: FS_TRI_VERT, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false,
    });
    this.matCube = raw(cubeToOctFrag(n), {
      uCube: { value: this.cubeRT.texture },
      uTileOrigin: { value: new THREE.Vector2() },
      uTileSize: { value: 256 },
      uFlipX: { value: 1.0 },
    });
    this.matFilter = raw(filterFrag(n), {
      uAtlas: { value: this.atlasA.texture },
      uTileOrigin: { value: new THREE.Vector2() },
      uTileSize: { value: 0 },
      uSrcLod: { value: 0 },
      uCell: { value: 0 },
      uRough: { value: 0 },
    });
    this.matIrr = raw(irrFrag(n), {
      uAtlas: { value: this.atlasA.texture },
      uTileOrigin: { value: new THREE.Vector2() },
      uTileSize: { value: IRR_SIZE },
      uCell: { value: 0 },
    });
    this.matProbe = raw(probeFrag(n), {
      uAtlas: { value: this.atlasA.texture },
      uHullTex: { value: hullTex },
      uCell: { value: 0 },
      uBlockOrigin: { value: new THREE.Vector2() },
    });
    this.matCopy = raw(COPY_FRAG, { uSrc: { value: this.atlasB.texture } });
  }

  get texture() { return this.atlasA.texture; }

  runPass(target, material, x, y, w, h) {
    target.viewport.set(x, y, w, h);
    target.scissor.set(x, y, w, h);
    target.scissorTest = true;
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.fsScene, this.fsCam);
  }

  totalSteps(iterations) {
    return iterations * (this.level.cells.length * 3 + (N_LODS - 1));
  }

  // yields after each unit of work; caller decides how many units per frame
  *bakeSteps(scene, matsys, iterations) {
    const { renderer, level } = this;
    for (let iter = 0; iter < iterations; iter++) {
      for (const cell of level.cells) {
        matsys.globals.uBake.value = 1.0;
        this.cubeCam.position.copy(cell.capture);
        this.cubeCam.update(renderer, scene);
        matsys.globals.uBake.value = 0.0;

        const row = cell.id * ROW_H;
        this.matCube.uniforms.uTileOrigin.value.set(LOD_X[0], row);
        this.matCube.uniforms.uTileSize.value = LOD_SIZES[0];
        this.runPass(this.atlasA, this.matCube, LOD_X[0], row, LOD_SIZES[0] + 2 * BORDER, LOD_SIZES[0] + 2 * BORDER);
        yield;
      }
      for (let k = 1; k < N_LODS; k++) {
        for (const cell of level.cells) {
          const row = cell.id * ROW_H;
          const w = LOD_SIZES[k] + 2 * BORDER;
          const fu = this.matFilter.uniforms;
          fu.uTileOrigin.value.set(LOD_X[k], row);
          fu.uTileSize.value = LOD_SIZES[k];
          fu.uSrcLod.value = Math.max(k - 2, 0); // slightly-blurred source: variance reduction
          fu.uCell.value = cell.id;
          fu.uRough.value = k / (N_LODS - 1);

          this.runPass(this.atlasB, this.matFilter, LOD_X[k], row, w, w);
          this.runPass(this.atlasA, this.matCopy, LOD_X[k], row, w, w);
        }
        yield;
      }
      for (const cell of level.cells) {
        const row = cell.id * ROW_H;
        const w = IRR_SIZE + 2 * BORDER;
        this.matIrr.uniforms.uTileOrigin.value.set(IRR_X, row);
        this.matIrr.uniforms.uCell.value = cell.id;
        this.runPass(this.atlasB, this.matIrr, IRR_X, row, w, w);
        this.runPass(this.atlasA, this.matCopy, IRR_X, row, w, w);
        yield;
      }
      // irradiance probe grids (warp-then-convolve per probe, one draw per cell)
      const blockW = PROBES_PER_ROW * PROBE_TILE;
      const blockH = Math.ceil(MAX_PROBES / PROBES_PER_ROW) * PROBE_TILE;
      for (const cell of level.cells) {
        const row = cell.id * ROW_H;
        this.matProbe.uniforms.uCell.value = cell.id;
        this.matProbe.uniforms.uBlockOrigin.value.set(PROBE_X, row);
        this.runPass(this.atlasB, this.matProbe, PROBE_X, row, blockW, blockH);
        this.runPass(this.atlasA, this.matCopy, PROBE_X, row, blockW, blockH);
        yield;
      }
    }
    this.renderer.setRenderTarget(null);
  }
}
