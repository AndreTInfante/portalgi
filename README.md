# PortalIBL POC

Proof of concept for PortalIBL - **portal-linked convex-hull environment map based specular lighting technique** - a middle ground between parallax-corrected cubemaps and ray marching, aimed at mobile VR.

The level is decomposed into convex cells (hulls). Each cell owns a baked HDR
octahedral environment map (specular mip column + irradiance tile) in one flat
atlas. Reflection rays intersect the enclosing hull analytically; where the exit
face is a portal, the shader blends a flat local resolve with a recursed lookup
into the neighbor cell (blend width scales with roughness × path length; zero
for mirror). Straight rays can't revisit a convex cell, so traversal is a
bounded loop with guaranteed progress. Diffuse GI comes from a baked lightmap on
static surfaces and per-cell irradiance probes on dynamic props.

Dynamic and free-standing objects — which shell methods otherwise flatten against
the walls — are approximated by small capsule sets that supply analytic contact
AO, soft shadows, and indirect reflection occlusion. The goal is to create a superficially ray-tracing-quality visual presentation on a mobile-friendly budget.

Ships at a locked 72Hz on Quest 3 (60 on a mid-range Android phone).

## Run

```
node serve.mjs 8123
# open http://127.0.0.1:8123
```

(Any static file server works; opening index.html from file:// won't, because of
texture CORS.)

## Controls

- LMB: Capture the mouse; WASD + mouse look, Shift to run
- LMB / E: grab a prop, click again to throw, RMB to drop
- Hold E + move the mouse: rotate the held prop.
- V: noclip fly (Space/Ctrl for up/down)
- HUD icon (top-right): mute

## Scene

Art-gallery / museum theme, 14 convex cells plus a skybox.
Props: diffuse/chrome/glass spheres and cubes, plus the carryable PBR models.
Glass = chrome sampled along the negated reflection vector

## Dynamic-object impostors (capsules)

Shell-based reflection flattens everything against the walls — fine for shallow
objects near a wall, painful for large free-standing ones. Each prop and static
model carries a hand-authored set of up to 8 capsules (`src/proxies.js`; edit
in-app with `?occedit=1`, then DUMP). Because they're density functions, one
ray/point test per effect gives smooth falloff:

- **Contact AO** — cone-footprint coverage, widening with surface roughness.
- **Soft shadows** — one ray per caster toward the cell's luminance-weighted
  average light direction. Unphysical but smooth as objects move, and cheap and
  consistent regardless of light count.
- **Indirect reflection occlusion** — the capsules are tested inside the portal
  traversal, before the cell walls, so reflected objects occlude correctly.

Static receivers evaluate capsule AO + shadows in texture space (per
lightmap texel into a quarter-res layer: statics baked once, dynamic props
re-evaluated per frame with exact-change detection, so an at-rest scene is
free). Props also respect per-light visibility baked at boot, so an object in a
light's shadow stays dark. Physics (`cannon-es`) matches the same capsules —
props are compound shapes strung along them, so collision fits what you see
reflected; static statues collide against convex hulls of their real surface
points.

## GUI knobs

Open in the top-right (collapsed to the title bar on phones). Add `?dev=1` for
the Perf and Bake folders.

- **Traversal** — portal hops (glass; 0 = classic PCCM everywhere), rough-scaled
  hops, edge blend + widths, portal de-aliasing bias, rough growth (1 =
  physical `t·rough/d`).
- **Display** — exposure (EV); **view**: None / Cell tint / Step heatmap /
  Irradiance only / White world / Lightmap / Specular only (8×); show portals;
  show collision shapes; portal culling; eye buffer scale.
- **Occluders** (`?dev=1`) — blob density / cone / re-emit, AO + shadow strength
  and clamp, capsule budget, range; DUMP.
- **Audio** (`?dev=1`) — master / music / sfx volume.
- **Bake** (`?dev=1`) — bounces, re-trace lightmap, re-bake cubemaps, offline
  bake.

The **edge blend** is cone-footprint anti-aliasing of the traversal partition,
applied per portal EDGE: silhouette edges (pillar corners, doorframes — real
geometry breaks the plane there, so the local flat sample is parallax-exact)
blend with roughness×distance width; continuation edges (the neighbor has a
coplanar surface: floor under a cut, the L-rooms' shared wall) never blend —
recursion is already seamless there and blending would ghost. Classified
automatically at build time into a per-portal bitmask.

Static surfaces use fixed unrolled traversal tuned per material (matte
walls/ceilings, one exact hop on glossy floors); glass and chrome run the
full recursive march the **portal hops** dial controls. Setting
hops to 0 flattens the whole scene to PCCM — the headline A/B. Compare the
glossy floor below the gallery→hall doorway: flat smudge at 0, correct depth
once hops ≥ 1.

URL params for headless screenshots: `?shot=1..19` drives fixed camera poses
(e.g. 1 gallery, 3 rotunda, 4 pillar hall, 6 L-room cut, 9 exhibit hall A,
10 cornell, 17 courtyard); `?mark=1` self-uploads
the PNG. Comparison overrides: `?steps=N` (0 = PCCM), `?blend=0|1`,
`?debug=0..6` (2 = step heatmap, 6 = specular-only 8×).

## Lightmapper (ground truth)

A GPU path tracer bakes all static lighting into a lightmap at startup
(`src/lightmap.js`, BVH raytracing in-shader via three-mesh-bvh):
direct light = shadow-rayed points + panel AREA lights (soft shadows; emitters
cast no shadows and never self-occlude), then bounce iterations gathering
albedo×lightmap — converged GI with AO. Static surfaces render albedo ×
lightmap, so lighting is globally consistent with no portal seams by
construction. Cubemap captures rasterize the lightmapped scene, which makes the
hull cubemaps (and therefore reflections, refractions of reflections, and the
prop probes) a faithful cache of ground truth — one capture iteration suffices.

- GUI (`?dev=1`): re-trace the lightmap (then cubemaps rebake automatically)
- Quality: `?lmden=16` (texels/m), `?lmrays=64` (gather rays), `?lmit=3`
  (bounce iterations), `?lmps=2` (panel-light samples); the PT pass renders in
  64px strips to stay clear of GPU watchdogs. Debug view "Lightmap" shows the
  raw bake.

## Offline bake (ship noise-free lighting)

Open `?bake=1` (or the GUI button) while running under `node serve.mjs`: the
app bakes at offline quality (defaults: density 32 on a 2048 atlas, 256 rays,
4 bounces, 12 panel samples — override with the usual `lm*` params), reads the
lightmap AND the cubemap atlas back, and PUTs them to the dev server, which
writes `baked/atlas.bin`, `baked/lightmap.bin` (raw float16 RGBA) and
`baked/manifest.json`. Every subsequent load finds the manifest and starts
instantly with the distributed textures — no baking, no noise; ship the
`baked/` folder with the app. Guards: artifact dimensions are validated
against the current level (mismatch falls back to a live bake), `?baked=0`
ignores the artifacts, and the `?dev=1` Bake controls re-enter the live pipeline
in-session.
`?recube` re-captures only the cubemaps from the existing master lightmap (the
fast path for any atlas-resolution or layout change — no need to re-run the
path trace).

## Quest / WebXR

The renderer is XR-enabled: an Enter VR button appears when WebXR is
available. Left stick = smooth move (head-relative, hull collision), right
stick = 30° snap turn, trigger = grab/carry with either controller (hand-to-hand
steal and two-handed carry work; release drops). An in-VR menu (point + right
trigger, or stick + A) exposes the headline levers — portal rendering on/off,
reflections, AO+shadows, framerate — with the fiddly dials on a tuning subpage.
Run a high-quality offline bake first so the headset loads baked artifacts
instead of baking.

Perf holds a locked 72Hz at near-native eye-buffer resolution; A/X toggles up to
90 (close but not locked). Adaptive foveation and dynamic occluder range ride
the frame-time headroom.

Easiest way onto a Quest for development (no HTTPS needed — localhost is a
secure context):

    adb reverse tcp:8123 tcp:8123
    # then open http://localhost:8123 in the Quest browser

For standalone hosting, serve the folder (including baked/) over HTTPS. The demo
also deploys to GitHub Pages via `.github/workflows/pages.yml`.

## Files

Authoring & data
- `src/level.js` — cell/portal authoring + hull plane + mesh generation
- `src/hulldata.js` — cell graph packed into a std140 UBO (DataTexture fallback)
- `src/atlas.js` — octahedral atlas layout (shared JS/GLSL constants)
- `src/proxies.js` — hand-authored occluder capsule sets per model
- `src/models.js`, `src/textures.js`, `src/materials.js`

Rendering
- `src/shaders.js` — traversal shader (`traceSpec`), scene shading, bake passes
- `src/bake.js` — cubemap capture → oct atlas → prefilter → irradiance
- `src/lightmap.js` — GPU path-traced lightmap; `src/bakedio.js` — offline bake I/O
- `src/occluders.js`, `src/dynocc.js`, `src/lightvis.js` — capsule AO/shadows,
  texture-space occlusion, per-light visibility
- `src/culling.js` — portal-graph cell culling · `src/warpfield.js` — experimental
  precomputed portal warp fields (`?warp=1`)

Runtime
- `src/main.js` — app entry, frame loop, shot/bake harness
- `src/player.js`, `src/props.js`, `src/physics.js` — movement, gravity-gun, cannon-es
- `src/vrmenu.js`, `src/touch.js` — in-VR menu, phone touch UI
- `src/audio.js`, `src/perf.js`, `src/debug.js`, `src/proxyedit.js` — audio,
  GPU headroom probe, GUI + view modes, in-app capsule editor

## Known limitations / next steps

- Prefilter is a progressive gaussian-in-angle blur, not energy-correct GGX.
- Dynamic props take no analytic point lights: diffuse comes from a per-cell
  IRRADIANCE PROBE GRID (shader mode 4) — up to 4×2×4 probes per cell stored
  as 8px octahedral tiles in the same atlas, trilinearly blended (8 taps).
  Each probe is convolved at bake time from its own position with the parallax
  warp applied to the radiance BEFORE the cosine convolution (warp-then-filter,
  the correct operation order — warping a pre-convolved map is the classic
  mistake). Convex cells mean probes see their whole cell: none of the
  DDGI-style visibility machinery is needed, and there is no intra-cell
  leaking by construction. Cell handoffs crossfade over 0.2s. Directional
  beams (spots, the sun) are supplied analytically on top, gated to each
  light's home cell. Specular needs no crossing help — coincident mid-plane
  portals + traversal make chrome and glass continuous through doorways.
- Doored walls' hull planes sit at the shared wall MID-plane: mutual door
  portals are the same rectangle on the same plane, hulls tile space with no
  dead gap, and cell handoff happens exactly at the shared plane. The visible
  wall meshes keep their thickness; those walls' reflections carry a WALL_T/2
  parallax error (classic-PCCM scale).
- Mid-gloss static surfaces are single-hop or matte for performance; directional
  lightmaps (L1 / dominant-direction) are the principled long-term answer.
- Glass covering the eye (2× full march at point-blank) is the accepted
  worst-case cost — everything else holds the frame budget.
- Beyond-portal silhouettes (e.g. the pillar seen behind a portal) are
  discontinuities in direction space; a precomputed warp-field LUT can't afford
  the angular resolution to resolve them without swimming/seams (`?warp=1` keeps
  the experiment, off by default), which is exactly why the analytic per-pixel
  walk IS the technique.
