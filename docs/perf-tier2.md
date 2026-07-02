# Perf Tier 2 - planning

Tier 1 (shipped): blendedIrr gated behind the lightmap-off fallback,
rough>0.65 specular early-out (1 irradiance tap instead of the hull walk),
FrontSide statics with normal-oriented winding, and recursive portal-frustum
culling (NDC rect narrowing through portals; the graph is the PVS; all-visible
during bakes; `?cull=0` and a GUI checkbox to A/B). In-VR frame-rate cap
toggle on A/X (72 <-> 90, label above controller 0).

Measure BEFORE starting Tier 2: on-device GPU ms in these spots, culling
on/off, 72 vs 90 cap:
1. gallery center facing the doorway (worst traversal fill: glossy floor)
2. exhibit hall A facing the models (prop-heavy: probe + texture bound)
3. rotunda facing the statue (big static model + marble floor)
4. cornell box interior (small cell baseline)

## Items, in expected win order

1. Hull data: DataTexture -> UBO (std140 uniform block)
   The traversal does 12+ dependent texelFetches per iteration per pixel from
   an RGBA32F texture. A ~34KB uniform block turns those into constant-register
   reads. Touches: hulldata.js (pack Float32Array -> UBO via
   THREE.UniformsGroup or raw WebGL UBO), shaders.js (uniform block decl,
   hfetch -> array indexing). Risk: three's UniformsGroup support with
   RawShaderMaterial; fallback is a manual gl.bindBufferBase. Expected: big
   win on Adreno, the hot loop dominates glossy-floor pixels.

2. Shader variants per mode (kill the uber-shader)
   One program serves lightmapped statics, probe props, glass, and the pane;
   every wave pays worst-case register pressure -> poor occupancy on mobile.
   Split via #define at makeMaterial time (MODE_STATIC / MODE_PROP /
   MODE_GLASS / MODE_PANE) and prune dead code per variant. Statics need no
   probe code; props need no lightmap code. Touches: shaders.js (wrap
   sections in #ifdef), materials.js (defines + program cache keys by mode).

3. XR framebuffer scale 0.9 + keep foveation 1.0
   One line before session start (renderer.xr.setFramebufferScaleFactor).
   ~20% fill for near-invisible sharpness loss. Make it a GUI slider
   (0.7-1.2) so it can be tuned on-device.

4. Exhibit model budget
   11 scans at raw topology + 1k texture sets. Actions: decimate to ~15k tris
   (meshoptimizer or Blender), 512px textures for the small props
   (pan/elephant/fan), and drop probe crossfade taps from 16 -> 8 by skipping
   uCellPrev sampling when uPrevMix < 0.15. Cheapest variant: per-prop
   distance fade of the crossfade.

5. Portal hops as a mobile quality dial
   uMaxSteps 3 -> 2 on Quest costs depth in doorway-through-doorway
   reflections only; wire to the same in-VR toggle cluster if fill is still
   the limiter after items 1-3.

## Deliberately deferred (Tier 3, revisit only if needed)
- KTX2/ASTC texture transcoding (4-8x texture bandwidth; needs a toktx
  pipeline + KTX2Loader vendoring)
- Cheaper probe basis (SH-L1 or 4-tap) - only if hall A still spikes
- Multiview / OCULUS_multiview (three support is limited)

## Open questions for on-device measurement
- Is the remaining cost fill-bound (scale test: does 0.8 framebuffer scale
  restore 90?) or geometry/bin-bound (does culling-off vs on change GPU ms
  when facing a wall?)
- Does the 72 cap hold everywhere with Tier 1 alone? If yes, Tier 2 items
  1-2 are about reaching locked 90, not about playability.
