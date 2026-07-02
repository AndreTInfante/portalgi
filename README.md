# PortalGI POC

Proof of concept for **portal-linked convex-hull cubemap reflections/GI** — a middle
ground between parallax-corrected cubemaps and ray marching, aimed at mobile VR.

The level is decomposed into convex cells (hulls). Each cell owns a baked HDR
octahedral environment map (specular mip column + irradiance tile) in one flat
atlas. Reflection rays intersect the enclosing hull analytically; where the exit
face is a portal, the shader blends a flat local resolve with a recursed lookup
into the neighbor cell (blend width scales with roughness × path length; zero
for mirror). Straight rays can't revisit a convex cell, so traversal is a
bounded loop with guaranteed progress. Diffuse GI comes from the irradiance
tile, no recursion. Bounce lighting comes from re-capturing the scene while it
samples the previous bake (the structure relights itself).

## Run

```
node serve.mjs 8123
# open http://127.0.0.1:8123
```

(Any static file server works; opening index.html from file:// won't, because of
texture CORS.)

## Controls

- Click to capture the mouse; WASD + mouse look, Shift to run
- Click / E: grab a prop (gravity-gun); click again to throw, RMB/E to drop
- V: noclip fly (Space/Ctrl for up/down)
- B: re-bake

## Scene

Art-gallery theme, 10 convex cells:
- **gallery** — rectangular, glossy wood floor, pedestals with the props
- **corridor** → **rotunda** — 10-sided drum, glossy marble, tall ceiling
- **pillar hall** — square room decomposed into 4 trapezoid cells around a
  central pillar (the pillar faces are exact hull walls; the cell cuts are
  virtual portals that cost traversal steps)
- **L-gallery** — L-shape split into 2 cells with a full-face virtual portal
- **darkroom** (off the far end of the L) — lights off, one small saturated
  corner lamp: stress test for diffuse props / irradiance in colored light

Props: diffuse/chrome/glass spheres and cubes. Glass = chrome sampled along the
negated reflection vector (HL:Alyx bottle trick) — carry it around to eyeball
environment-approximation error directly. There is also a **debug pane** (on the
gallery bench): a near-clear glass sheet that billboards to the camera while
held, so it shows the raw hull approximation straight-through — walls and
paintings match the real view, anything not in the structure (benches, props)
vanishes or smears.

## GUI knobs

- **portal hops** — 0 is the classic PCCM baseline; 3 is the intended look.
  Compare the glossy floor below the gallery→hall doorway: flat smudge at 0,
  correct depth at 3.
- **edge blend** + widths — cone-footprint anti-aliasing of the traversal
  partition, applied per portal EDGE: silhouette edges (pillar corners,
  doorframes — real geometry breaks the plane there, so the local flat sample
  is parallax-exact) blend with roughness×distance width; continuation edges
  (the neighbor has a coplanar surface: floor under a cut, the L-rooms' shared
  wall) never blend — recursion is already seamless and blending would ghost.
  Classified automatically at build time into a per-portal bitmask.
- **rough growth /m** — distance-driven roughness (mip) accumulation along the ray
- **irr portal blend (m)** — cross-portal diffuse blending distance; 0 shows the
  raw irradiance seams at cell cuts (view: "Irradiance only" makes it obvious)
- **view** — cell tint / traversal step heatmap / irradiance only / white world
- URL params for screenshots: `?shot=1..8&steps=N&blend=0|1&debug=N&irr=X`
  (6 = L-room cut, 7 = debug pane held up, 8 = darkroom)

## Lightmapper (ground truth)

A GPU path tracer bakes all static lighting into a lightmap at startup
(`src/lightmap.js`, BVH raytracing in-shader via three-mesh-bvh):
direct light = shadow-rayed points + panel AREA lights (soft shadows; emitters
cast no shadows and never self-occlude), then bounce iterations gathering
albedo×lightmap — converged GI with AO. Static surfaces render albedo ×
lightmap; per-cell analytic lights are gone from the lit path, so lighting is
globally consistent (no portal seams by construction). Cubemap captures
rasterize the lightmapped scene, which makes the hull cubemaps (and therefore
reflections, refractions of reflections, and the prop probes) a faithful cache
of ground truth — one capture iteration suffices.

- L key / GUI: re-trace the lightmap (then cubemaps rebake automatically)
- `?lm=0` reverts to the analytic + feedback pipeline
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
ignores the artifacts, and L/B re-enter the live pipeline in-session.

## Files

- `src/level.js` — cell/portal authoring + hull plane + mesh generation
- `src/hulldata.js` — cell graph packed into an RGBA32F texture
- `src/atlas.js` — octahedral atlas layout (shared JS/GLSL constants)
- `src/shaders.js` — traversal shader (`traceSpec`), scene shading, bake passes
- `src/bake.js` — cubemap capture → oct atlas → prefilter → irradiance
- `src/materials.js`, `src/textures.js`, `src/player.js`, `src/props.js`, `src/debug.js`

## Known limitations / next steps

- Prefilter is a progressive gaussian-in-angle blur, not energy-correct GGX.
- Diffuse seams at virtual portal cuts are handled by shader-side cross-portal
  irradiance blending (`blendedIrr`, ~20 extra texel fetches per surface
  fragment — on mobile you'd precompute per-vertex weights or restrict it to
  portal-adjacent geometry). The neighbor weight reaches 1.0 at the portal
  plane (a normalized true 50/50), which makes shading independent of which
  cell claims the point — continuous for static seams and for props at the
  moment their cell assignment flips.
- Dynamic props take no analytic lights: diffuse comes from a per-cell
  IRRADIANCE PROBE GRID (shader mode 4) — up to 4×2×4 probes per cell stored
  as 8px octahedral tiles in the same atlas, trilinearly blended (8 taps).
  Each probe is convolved at bake time from its own position with the parallax
  warp applied to the radiance BEFORE the cosine convolution (warp-then-filter,
  the correct operation order — warping a pre-convolved map is the classic
  mistake). Convex cells mean probes see their whole cell: none of the
  DDGI-style visibility machinery is needed, and there is no intra-cell
  leaking by construction. Cell handoffs crossfade over 0.2s. Specular needs
  no crossing help — coincident mid-plane portals + traversal make chrome and
  glass continuous through doorways.
- Doored walls' hull planes sit at the shared wall MID-plane: mutual door
  portals are the same rectangle on the same plane, hulls tile space with no
  dead gap, and cell handoff happens exactly at the shared plane. The visible
  wall meshes keep their thickness; those walls' reflections carry a WALL_T/2
  parallax error (classic-PCCM scale).
- Residual brightness offsets between rooms come from per-cell captures and
  unshadowed per-cell lights; the real fix is baking probes AND a lightmap from
  one ground-truth lightmapper pass so the hulls become a faithful cache.
- Cubes collide as spheres; no prop-vs-prop collision.
- Per-cell analytic lights have no shadows; cells joined by open portals must
  share their light lists to stay continuous (see level.js).
- No WebXR yet — the shader is deliberately mobile-friendly (≤4 hops, one
  texture array-style atlas, no derivatives in the loop).
