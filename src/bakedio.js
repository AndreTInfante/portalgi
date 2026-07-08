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

// Read a response body into a Uint8Array, reporting network bytes as chunks
// arrive (onBytes(received, total)). Streams when possible so the progress
// counter tracks the actual download.
async function streamBytes(res, onBytes) {
  const total = +res.headers.get('content-length') || 0;
  if (!res.body || !res.body.getReader) { // no streaming body (very old browsers)
    const u8 = new Uint8Array(await res.arrayBuffer());
    if (onBytes) onBytes(u8.length, u8.length || total);
    return u8;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (onBytes) onBytes(received, total);
  }
  const out = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

// Reverse the encoder's hi/lo byte-plane split (scripts/compress-baked.mjs):
// the first half holds every float16's low byte, the second half its high byte.
function unsplit16(split) {
  const n = split.length, half = n >>> 1;
  const out = new Uint8Array(n);
  for (let j = 0, i = 0; j < half; j++, i += 2) {
    out[i] = split[j];
    out[i + 1] = split[half + j];
  }
  return out;
}

async function gunzip(u8) {
  const stream = new Response(u8).body.pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Fetch the raw half-float bytes of a baked binary, reporting download progress
// and returning an ArrayBuffer. Kept separate from texture construction so the
// (large) download can be kicked off early and overlap the rest of boot.
// With opts.gzip, fetch the pre-compressed `<path>.gz` (byte-split + gzip,
// ~4x smaller), stream-track the compressed download, then inflate and
// un-split back to the exact original bytes. Falls back to the raw file if the
// compressed one is missing.
export async function fetchHalfBuffer(path, onBytes, opts = {}) {
  if (opts.gzip) {
    const res = await fetch(path + '.gz');
    if (res.ok) {
      const bytes = await streamBytes(res, onBytes);
      // magic-byte guard: if a CDN transparently inflated the .gz (served it
      // with Content-Encoding: gzip), `bytes` is already the split payload
      const split = (bytes[0] === 0x1f && bytes[1] === 0x8b) ? await gunzip(bytes) : bytes;
      return unsplit16(split).buffer;
    }
    // compressed artifact absent -> fall through to the raw file
  }
  const res = await fetch(path);
  if (!res.ok) throw new Error(`missing baked texture: ${path}`);
  const bytes = await streamBytes(res, onBytes);
  return bytes.buffer;
}

export function halfTextureFromBuffer(buf, w, h, mips = false) {
  if (buf.byteLength !== w * h * 4 * 2) {
    throw new Error(`size mismatch: got ${buf.byteLength}, expected ${w * h * 4 * 2}`);
  }
  const tex = new THREE.DataTexture(new Uint16Array(buf), w, h, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = mips;
  tex.needsUpdate = true;
  return tex;
}

export async function loadHalfTexture(path, w, h, mips = false) {
  const buf = await fetchHalfBuffer(path);
  return halfTextureFromBuffer(buf, w, h, mips);
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
