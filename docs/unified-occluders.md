# Unified analytic occluders - design + measurement plan

Decision (2026-07-03): fold dynamic-object reflections into the hull/portal
traversal itself, replacing the screen-space mirrored imposters ("smudges")
if the numbers allow. Each cell carries a small list of analytic spheroid
occluders; reflection rays test them while walking the portal graph, before
the cell walls. Occlusion is SUBTRACTIVE ONLY.

## Why

- Works on every reflective surface (walls, chrome, glass, mirror), not just
  up-facing floors - the stencil/mirror approach is floor-only by construction.
- Cross-portal correctness: today a reflection ray that exits through a
  doorway sees no smudges in the next cell. Unified occluders fix this free.
- View-dependent correctness: the mirrored blob is view-independent; ray
  occlusion darkens the actual reflection direction, so alignment problems
  (including the upside-down-prop bug) disappear as a category - spheres are
  rotation-invariant, fitted local, transformed by the prop matrix per frame.
- Chrome/glass get dynamic-prop presence (the big immersion win).
- One system instead of stencil masks + mirror matrices + per-floor bounds.
- AO byproduct: sphere-vs-hemisphere occlusion has a closed form (Quilez),
  ~10 ALU per sphere, no ray. Multiply into diffuse for DYNAMIC props only
  (statics already have path-traced AO in the lightmap).

## Cost model (why the budget fear is manageable)

The cost is NOT "per reflective pixel x per spheroid". It is:

- per reflective pixel: one bounding-sphere REJECT per prop per visited cell
  (~10-15 ALU each; ~50-100 ALU for 4-6 props). The traversal loop is
  memory-bound (12+ dependent RGBA32F texelFetches per iteration), so pure-ALU
  rejects hide inside fetch latency on a tiled mobile GPU.
- per HIT pixel (ray actually passes near an object): full chord/density
  evaluation - the same screen coverage the current smudges already rasterize.

Disciplines that keep this true:
1. SPHERES in the hot loop (rotation-invariant, no basis transform). A prop is
   3-5 spheres; a prop-level bounding sphere gates them.
2. Hard caps: fixed-size per-cell uniform array (<= 12 spheres/cell), uniform
   or UBO storage (constant-register reads, no texture traffic).
3. LOD: occluders evaluated only for cells within N portal hops of the camera;
   keep the rough > 0.65 early-out (walls skip occluders like they skip the
   traversal).
4. Cone-widening: grow effective radii and cut density with
   rough x rayDistance (same model as uDistRough) so occluders stay consistent
   with GGX mip blur and fade naturally with distance.

## Shape authoring

- Automatic fit: bounding box / per-submesh bounding boxes -> sphere set
  (reuse the percentile band-fitting machinery from the smudge cone fit).
- Manual authoring pass for hero objects (horse, whale, select furniture):
  artist-aligned ellipsoid/sphere sets stored with the model defs. In-app
  authoring aid: a debug mode that renders the occluder sets as translucent
  wireframes over the mesh, GUI-nudgeable, dump-to-clipboard like the smudge
  dashboard.

## Subtractive-only (v1)

Blocked light goes to black: transmittance multiplies the traced atlas sample.
Multiple hits saturate - no depth sorting needed. This is what the planar
smudges already approximate (tuning found near-black shapes read best).
Known concern: white/bright objects (porcelain horse) reflected as dark blobs,
especially in chrome. Parked extension if it reads wrong: on hit pixels only,
re-add occluderTint x sampleIrr(cell, R) - flat irradiance-lit tint instead of
black, one extra tap, no sorting. Full colored blobs with correct layering
would need sorting - deliberately out of scope.

## Budget philosophy

Target device: Quest 3 (Quest 2 unsupported). The bar is NOT "the demo holds
90Hz" - it is game-scale headroom: a real title adds bigger levels, animated
characters, game logic, audio, UI. Success criterion: portal GI + occluders
fit in a slice small enough that the frame is mostly EMPTY at 90Hz in the
demo. Measure, don't vibe: get ms numbers for each feature via the harness.

## Measurement methodology (perf harness)

GPU timer queries (EXT_disjoint_timer_query_webgl2) are unavailable in the
Quest browser, and at a locked/vsynced 90Hz raw frame deltas only show
quantized misses. So we measure headroom by CALIBRATED SYNTHETIC LOAD:

1. Burn pass: a fullscreen pass with a tunable ALU loop (uniform-driven,
   fragCoord-seeded so it can't constant-fold, writes ~0 additively so the
   image is unchanged). Adds GPU load in controlled increments.
2. Sweep: hold each burn level ~3s, measure dropped-frame rate from rAF/XR
   frame deltas (drop = delta > 1.5x median period); step up until drops
   exceed threshold. The highest sustainable level = headroom in burn units.
3. ms calibration: run the same sweep at the 90Hz and 72Hz session rates
   (toggle already on A/X). The tip-level difference spans exactly
   13.89 - 11.11 = 2.78ms, giving ms-per-burn-unit on the actual device.
4. A/B: feature cost in ms = (tip level with feature off - tip level with
   feature on) x ms-per-unit. Config matrix via existing URL params + GUI:
   steps (0/1/3), cull, smudge, and later occluders.

On-device results display on an in-headset HUD label (+ localStorage history);
the deployed Pages origin cannot PUT to the dev server, so numbers are read
from the HUD. (Optional later: self-signed-cert LAN server for auto-upload.)

## First measurements (Quest 3, 2026-07-03, in-headset sweeps)

Sustainable burn level (step 20u; before bisection landed, so +-20u):

| config                  | view                 | 90Hz | 72Hz |
|-------------------------|----------------------|------|------|
| steps3 + smudges        | cornell/mirror room  | 100u | 160u |
| steps0 + smudges        | cornell/mirror room  | 100u | 140u |
| steps0, no smudges      | cornell/mirror room  | 100u | 180u |
| steps3 + smudges        | pillar hall (worst)  |  40u | 100u |
| steps0 + smudges        | pillar hall (worst)  |  80u | 100u |
| steps0, no smudges      | pillar hall (worst)  | 120u | 160u |

Calibration: the two steps3 rate pairs both give 60u per 2.78ms
-> ~0.046 ms/unit (~21 u/ms). Same-rate deltas at the pillar-hall worst view,
90Hz:

- full portal GI (traversal + smudges) vs bare: 80u  ~= 4 ms
- traversal depth (steps 3 vs 0):               40u  ~= 2 ms (Cornell: ~0 -
  cost lives where glossy fill crosses portals)
- planar smudges:                               40u  ~= 2 ms (!) - grazing
  views rasterized the full mirrored blobs; footprint depth clamp added in
  response, re-measure

Caveats learned: Cornell pins at 100u across all configs at 90Hz (that view
appears pacing-bound, not GPU-bound - use pillar hall or 72Hz for A/Bs);
72<->90 calibration is fuzzed by GPU DVFS, so same-rate deltas are the gold
standard; step quantization put +-1ms error bars on differences (bisection
refinement added in response, resolution ~5u ~= 0.25ms).

## Work plan (2026-07-03)

Phase A - UBO foundation (Tier 2 item 1, shared infra for occluders):
1. hulldata.js emits the SAME packed vec4 stream as a Float32Array alongside
   the DataTexture (one packing routine, two consumers during transition).
2. TRACE_GLSL: std140 uniform block, hfetch() becomes flat array indexing;
   texture path kept behind a compile-time define as instant fallback if
   three's UniformsGroup misbehaves.
3. materials.js: one static-usage UniformsGroup attached to every scene
   material. Verify shots pixel-similar; commit.

Phase B - occluder plumbing (?occluders=1):
1. occluders.js: auto-fit sphere sets per dynamic prop (per-submesh bounding
   spheres, capped ~5/prop, plus one prop-level bounding sphere); per-frame
   world transform + per-cell packing into a dynamic-usage UniformsGroup.
   V1 scope: DYNAMIC props only - statics stay in the captures (occluding
   them too would double-darken); hero statics come later with the manual
   authoring pass + capture-exclusion decision.
2. traceSpec: per cell visited (within uOccHops of the start, LOD), test the
   segment against that cell's list - prop bound reject, then sphere chords
   -> transmittance, cone-widened by rough x distance, distance falloff;
   multiply the final atlas sample. Subtractive only, saturating.
3. GUI 'Occluders' folder (enable, density, falloff, widen, LOD hops) in the
   dashboard pattern: Andre tunes, dumps values, they get baked as defaults.

Phase C - measure on device: sweep A/B occluders vs (clamped) smudges at the
worst view + a chrome-ball-in-hand view; decide the smudge system's fate
(retire for dynamics / keep as static contact grounding).

Phase D - later: manual capsule authoring for horse/whale/furniture
(wireframe debug view + GUI nudge + JSON dump), analytic sphere AO into the
diffuse term for dynamics. Finer-than-material self-skip if groups prove too
coarse: per-vertex occluder-ignore hints (e.g. a group id in vertex colors,
fetched against the occluder array) so regions of one mesh can ignore
different blob sets - Andre's suggestion 2026-07-03. If the technique is committed to long-term:
auto-exclude anything carrying an occluder imposter from the CAPTURES
(statics are currently represented twice - smeared in the atlas AND as an
occluder blob).

Self-occlusion is IDENTITY, not geometry (learned the hard way): a flat
object's capsule must bulge past it, so nearby foreign surfaces (the floor
under a pan) are GENUINELY inside it - no interior-distance margin can
separate "floor in the bulge" (must occlude: contact shadow) from "bench
seat in its own capsule" (must not). Occlusion GROUPS solve it exactly:
every entry records the group of the material(s) it approximates (one group
per prop; shared per cell-builder material for furniture; per statue mesh),
a pixel skips only its own group, and floors/walls carry no group so they
are occluded by everything. Cheaper than the geometric test it replaced.

Shipped since the plan was written: capsule primitive (sphere swept along a
segment - two vec4 slots, a==b degenerates to a sphere; rotation is just
transforming two endpoints); tinted re-emission (blocked light re-emits
occluder albedo x cell irradiance x uOccTint, user-tuned 0.8 - it is ~AO
plus optically-plausible ambient); cone-footprint falloff (occlusion peak =
r^2/rw^2 with rw grown by surface-rough x distance: chrome sees solid
occluders with feathered edges at any distance, rough floors see them fade
with distance, energy-conserving with the blur spread).

## Verdict (Quest 3 batch, 2026-07-03, pillar-hall worst view, 90Hz)

| config              | sustainable | marginal vs props-off |
|---------------------|-------------|-----------------------|
| steps0              | 90u         | traversal depth ~1.6ms |
| props-off (rh1)     | 55u         | baseline              |
| flat-hops (rh0)     | 55u         | ladder: ~0 at this view (keep - free) |
| occluders           | 50u         | ~0.23ms               |
| smudges             | 10u         | ~2.1ms                |

Unified analytic occluders: ~0.23ms for furniture + statues + props on every
reflective surface including chrome - ~9x cheaper than the planar smudges
while doing strictly more. DECISION: analytic occluders are the default and
the planar smudge system is REMOVED outright (src/reflections.js, its
stencil visible-surface mask, GUI folder, and batch config - strictly worse,
not worth carrying). Occluder budget raised with the measured headroom
(64 entries / 128 capsules / 16 per cell / 8 per prop; statue band fits to
5). Full portal GI (deep traversal + occluders) ~1.85ms at the worst view
with ~2.3ms of measured synthetic headroom remaining.

## Perf round 2 (2026-07-03, after traversal levers + UBO ceiling revert)

| config    | batch 1 | batch 3 |
|-----------|---------|---------|
| steps0    | 90u     | 90u     |
| occ-off   | 55u     | 70u     |
| flat-hops | 55u     | 70u     |
| occluders | 50u     | 50u     |

- PLATFORM CONSTRAINT (batch 2, reverted): ~15.7KB combined UBO regressed
  every config incl. steps0 (which runs none of the changed code) - Adreno
  demotes all uniform-block reads once the fast constant store overflows.
  ~13KB total measured safe. Occluder array sizes are capacity, not budget.
- Traversal levers (portal-plane mask, first-crossing-only blend, single-tap
  blend partials): traversal delta 35u -> 20u (~1.6ms -> ~0.92ms). Target
  (<1.5ms) met. NOTE: single-tap on recursed TERMINALS was reverted 2026-07-04
  (mip popping at portal thresholds in-headset); the blend-partial single tap
  stays.
- Bottleneck shifted: the occluder marginal cost read as 5u against the
  pre-lever baseline but 20u (~0.92ms) now - its UBO traffic used to hide
  under the hull-scan reads the mask eliminated. Full GI still ~1.85ms.
  Next levers if needed: pack uOccMeta+uOccColor into one vec4 (one fewer
  read per candidate entry), uOccHops LOD 2 -> 1 (quality dial, GUI-testable
  with zero code).

## Ground truth (ovrgpuprofiler render-stage trace, gallery worst view, 2026-07-03)

Session ran at 72Hz (74 surface executions/s). Per frame, 3360x1760 MSAA4,
44/72 bins rendered (FOV mask):
  Render 10.1ms + Preempt 1.15ms (compositor, not ours) + Binning 0.43ms
  + StoreColor 0.33ms = ~12.4ms total, ~11.2ms net app GPU.
So the gallery prop view genuinely exceeds the 90Hz budget (11.1ms) on the
current build - the reported dip was real load (thermals can only stack on
top). At 72Hz it fits with ~1.5ms spare. Realtime counters at cruise:
wave occupancy 52% (the structural ceiling -> shader variants), texture
fetch stall 2% (atlas hot set fits L2: 30% L1 miss, 0.06% L2 miss), ALU 30%,
bandwidth ~3GB/s, i-cache 0.1% - nothing else near saturation.
Ground-truth-sized levers for 90Hz in dense rooms: framebuffer scale 0.9
(~-1.9ms of the 10.1ms render), occluder LOD dial, shader variants
(occupancy), or ship dense rooms at 72/dynamic rate. Note: drawcall-level
ovrgpuprofiler tracing does not attach to the Browser privileged process;
render-stage level is the floor for web content.

## Rollout

1. Perf harness (this session): frame stats, burn pass, auto-sweep, HUD, GUI.
2. Baseline numbers for the current build (traversal depth, culling, smudges).
3. Occluders behind ?occluders=1, current smudges kept intact as control.
4. A/B on device; decide whether the planar system retires or stays as the
   far-field LOD.
