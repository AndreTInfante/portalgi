// Offline-bake persistence: read HDR render targets back, encode as raw
// float16 RGBA binaries + a manifest, PUT them to the dev server (/baked/),
// and load them back as DataTextures on startup - skipping all baking.
import * as THREE from 'three';

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
function toHalf(v) {
  f32[0] = v;
  const x = u32[0];
  const sign = (x >> 16) & 0x8000;
  let exp = (x >> 23) & 0xff;
  let frac = x & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (frac ? 1 : 0);
  exp = exp - 127 + 15;
  if (exp >= 0x1f) return sign | 0x7c00;
  if (exp <= 0) {
    if (exp < -10) return sign;
    return sign | ((frac | 0x800000) >> (14 - exp));
  }
  return sign | (exp << 10) | (frac >> 13);
}

// Read any texture as float32 via a copy into an RGBA32F target (the only
// read format guaranteed for float color buffers), then pack to half.
export function textureToHalfBytes(renderer, srcTex, w, h) {
  const rt = new THREE.WebGLRenderTarget(w, h, {
    type: THREE.FloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
    generateMipmaps: false, depthBuffer: false,
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 3, -1, -1, 3], 2));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 10);
  const mat = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: `in vec2 position; void main() { gl_Position = vec4(position, 0.0, 1.0); }`,
    fragmentShader: `precision highp float;
uniform sampler2D uSrc;
out vec4 fragColor;
void main() { fragColor = texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0); }`,
    uniforms: { uSrc: { value: srcTex } },
    depthTest: false, depthWrite: false,
  });
  const scene = new THREE.Scene();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  scene.add(mesh);
  renderer.setRenderTarget(rt);
  renderer.render(scene, new THREE.Camera());
  const px = new Float32Array(w * h * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, w, h, px);
  renderer.setRenderTarget(null);
  rt.dispose(); geo.dispose(); mat.dispose();
  const out = new Uint16Array(px.length);
  for (let i = 0; i < px.length; i++) out[i] = toHalf(px[i]);
  return new Uint8Array(out.buffer);
}

export async function putFile(path, body) {
  const res = await fetch(path, { method: 'PUT', body });
  if (!res.ok) throw new Error(`save failed for ${path}: HTTP ${res.status}`);
}

export async function fetchManifest() {
  try {
    const res = await fetch('./baked/manifest.json', { cache: 'no-store' });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function loadHalfTexture(path, w, h, mips = false) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`missing baked texture: ${path}`);
  const buf = await res.arrayBuffer();
  if (buf.byteLength !== w * h * 4 * 2) throw new Error(`size mismatch for ${path}`);
  const tex = new THREE.DataTexture(new Uint16Array(buf), w, h, THREE.RGBAFormat, THREE.HalfFloatType);
  // mips (the lightmap): distant floors/walls were sampling an unmipped
  // 2048x2752 texture - worst-case cache locality AND minification shimmer.
  // RGBA16F is filterable+renderable here (EXT_color_buffer_float required
  // at boot), so generateMipmap works; chart PAD is 4px so levels 1-2 stay
  // inside their gutters. The atlas keeps manual LOD + its own borders.
  tex.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = mips;
  tex.needsUpdate = true;
  return tex;
}

export async function saveBaked(renderer, atlasRT, lightmapRT, settings) {
  const atlas = textureToHalfBytes(renderer, atlasRT.texture, atlasRT.width, atlasRT.height);
  const lm = textureToHalfBytes(renderer, lightmapRT.texture, lightmapRT.width, lightmapRT.height);
  await putFile('./baked/atlas.bin', atlas);
  await putFile('./baked/lightmap.bin', lm);
  await putFile('./baked/manifest.json', JSON.stringify({
    version: 1,
    date: new Date().toISOString(),
    atlas: { w: atlasRT.width, h: atlasRT.height },
    lightmap: { w: lightmapRT.width, h: lightmapRT.height },
    settings,
  }, null, 2));
  return (atlas.length + lm.length) / 1e6;
}

// Rewrite ONLY the cubemap atlas (e.g. after an atlas-resolution change),
// reusing the existing lightmap.bin untouched. The lightmap is the expensive
// path-traced artifact and is unaffected by the atlas layout, so this skips
// the hour-long relight entirely. prevManifest carries the lightmap dims +
// original bake settings forward unchanged.
export async function saveAtlasOnly(renderer, atlasRT, prevManifest) {
  const atlas = textureToHalfBytes(renderer, atlasRT.texture, atlasRT.width, atlasRT.height);
  await putFile('./baked/atlas.bin', atlas);
  await putFile('./baked/manifest.json', JSON.stringify({
    ...prevManifest,
    date: new Date().toISOString(),
    atlas: { w: atlasRT.width, h: atlasRT.height },
    recubedFrom: prevManifest.date, // provenance: lightmap predates this atlas
  }, null, 2));
  return atlas.length / 1e6;
}
