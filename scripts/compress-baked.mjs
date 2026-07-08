// Post-bake deploy step: compress the baked half-float binaries for
// distribution. Each float16 is little-endian [lo, hi]; the hi bytes
// (sign/exponent/top-mantissa) vary smoothly while the lo bytes are near-noise.
// Deinterleaving them into two contiguous planes lets plain gzip compress the
// smooth plane hard -- ~28% for the atlas, ~23% for the lightmap, better than
// brotli on the interleaved data and decodable natively in-browser via
// DecompressionStream('gzip'), no wasm.
//
// Writes baked/<name>.gz next to the raw files and stamps baked/manifest.json
// with `"compression": "split16-gzip"` so the runtime knows to fetch + inflate.
// Run after `?bake=1` (or `?recube`), before committing / deploying:
//   node scripts/compress-baked.mjs
import { readFileSync, writeFileSync } from 'fs';
import { gzipSync } from 'zlib';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['atlas.bin', 'lightmap.bin'];

// deinterleave: out[0..half) = every low byte, out[half..n) = every high byte
function byteSplit(buf) {
  const n = buf.length, half = n >>> 1;
  const out = Buffer.allocUnsafe(n);
  for (let i = 0, j = 0; i < n; i += 2, j++) {
    out[j] = buf[i];
    out[half + j] = buf[i + 1];
  }
  return out;
}

const mb = b => (b / 1048576).toFixed(1);
let rawTotal = 0, gzTotal = 0;
for (const f of FILES) {
  const raw = readFileSync(join(ROOT, 'baked', f));
  if (raw.length % 2) throw new Error(`${f}: odd byte length -- not float16 data?`);
  const gz = gzipSync(byteSplit(raw), { level: 9 });
  writeFileSync(join(ROOT, 'baked', f + '.gz'), gz);
  rawTotal += raw.length; gzTotal += gz.length;
  console.log(`${f}: ${mb(raw.length)} MB -> ${f}.gz ${mb(gz.length)} MB  (${(100 * gz.length / raw.length).toFixed(1)}%)`);
}

const mpath = join(ROOT, 'baked', 'manifest.json');
const manifest = JSON.parse(readFileSync(mpath, 'utf8'));
manifest.compression = 'split16-gzip';
writeFileSync(mpath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`\ntotal ${mb(rawTotal)} MB -> ${mb(gzTotal)} MB  (${(100 * gzTotal / rawTotal).toFixed(1)}%)`);
console.log('manifest.json: compression = split16-gzip');
