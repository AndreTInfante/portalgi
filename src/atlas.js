// Octahedral atlas layout. One flat RGBA16F texture, no hardware mips:
// each cell is a row; LOD tiles (with 2px gutter borders baked with correct
// octahedral wrap content) sit side by side, plus one irradiance tile.
// Trilinear filtering is done manually in the shader (2 bilinear taps).

export const LOD_SIZES = [256, 128, 64, 32, 16, 8, 4];
export const BORDER = 2;
export const N_LODS = LOD_SIZES.length;

const xs = [];
{
  let x = 0;
  for (const s of LOD_SIZES) { xs.push(x); x += s + 2 * BORDER; }
  xs.push(x); // irradiance tile offset
}
export const LOD_X = xs.slice(0, N_LODS);
export const IRR_X = xs[N_LODS];
export const IRR_SIZE = 32;
export const ROW_H = LOD_SIZES[0] + 2 * BORDER;

// per-cell irradiance probe grid: up to 32 probes/cell, each an 8px oct tile
// with the usual 2px gutters, packed 8 per row in a block right of the irr tile
export const PROBE_SIZE = 8;
export const PROBE_TILE = PROBE_SIZE + 2 * BORDER;
export const PROBES_PER_ROW = 8;
export const MAX_PROBES = 32;
export const PROBE_X = IRR_X + IRR_SIZE + 2 * BORDER;
export const ATLAS_W = PROBE_X + PROBES_PER_ROW * PROBE_TILE;

export function atlasHeight(numCells) { return numCells * ROW_H; }

// GLSL constants matching this layout, injected into every shader that samples it.
export function atlasGLSL(numCells) {
  return `
const int N_LODS = ${N_LODS};
const float MAX_SPEC_LOD = ${(N_LODS - 1).toFixed(1)};
const float LOD_X[${N_LODS}] = float[${N_LODS}](${LOD_X.map(v => v.toFixed(1)).join(', ')});
const float LOD_S[${N_LODS}] = float[${N_LODS}](${LOD_SIZES.map(v => v.toFixed(1)).join(', ')});
const float IRR_X = ${IRR_X.toFixed(1)};
const float IRR_S = ${IRR_SIZE.toFixed(1)};
const float ROW_H = ${ROW_H.toFixed(1)};
const float BORDER_PX = ${BORDER.toFixed(1)};
const float PROBE_X = ${PROBE_X.toFixed(1)};
const float PROBE_S = ${PROBE_SIZE.toFixed(1)};
const float PROBE_TILE = ${PROBE_TILE.toFixed(1)};
const int PROBES_PER_ROW = ${PROBES_PER_ROW};
const vec2 ATLAS_SIZE = vec2(${ATLAS_W.toFixed(1)}, ${atlasHeight(numCells).toFixed(1)});
`;
}
