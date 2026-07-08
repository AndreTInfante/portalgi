// Boot-time asset-load progress, shared across the heterogeneous loaders
// (raw-fetch textures, GLTF exhibits, painting/sky TextureLoaders, and the
// streamed baked binaries). Each loader calls tick() as one file finishes;
// main.js registers the total up front and supplies the overlay renderer.
let done = 0;
let total = 0;
let onChange = null;

export function initProgress(totalFiles, render) {
  done = 0;
  total = totalFiles;
  onChange = render;
  if (onChange) onChange();
}

// advance the counter by n completed files (default 1)
export function tick(n = 1) {
  done += n;
  if (onChange) onChange();
}

export function progressCounts() {
  return { done, total };
}
