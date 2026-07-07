# Diffuse light-probe redesign

Plan for two changes to the dynamic-prop diffuse GI:

1. **Optimization-based placement** — greedily move probes so grid divisions align with
   boundaries of light (shadow edges, shafts, the floor→ceiling gradient).
2. **Unified through-door interpolation** — graft adjacent cells' probes into one cohesive
   grid, connections gated to the portal, so there is *one* interpolation rule and no
   time-based door special-casing.

Scope note: probes feed **dynamic props only** (≤14 of them, 0.36–1.4 m). Static geometry
uses lightmaps and is untouched. `culling.js` is out of the blast radius by design.

---

## 1. The current system (what we're replacing)

- **Placement** ([level.js:499-524](../src/level.js#L499-L524)): uniform axis-aligned lattice
  in each hull's XZ bbox; `dims = [clamp(round(w/2.4)+1,2,4), 2, clamp(round(d/2.4)+1,2,4)]`,
  vertical always 2 → ≤ 4×2×4 = 32 = `MAX_PROBES`. **Positions are implicit** from
  `(min, size, dims)` — never stored.
- **Storage** ([hulldata.js:34-46](../src/hulldata.js#L34-L46)): 3 texels/cell (34-36) hold
  only `min/size/dims`. Texels 37-39 are the only spare (12 floats).
- **Bake** (`probeFrag`, [shaders.js:1379-1442](../src/shaders.js#L1379-L1442)): each probe
  reconstructs its lattice position, is pulled 0.25 m inside every hull plane, then a 64-sample
  cosine hemisphere is warp-then-convolved — but sampling **only its own cell's** radiance
  (LOD 2). This is why adjacent cells disagree at a portal.
- **Runtime** (`probeDiffuse`, [shaders.js:836-861](../src/shaders.js#L836-L861)): per-vertex
  8-corner trilinear over the lattice; `octEncode(N)` picks the direction. 8 atlas taps.
- **Through-door handoff** — a **time-based** 0.2 s crossfade, not spatial:
  [materials.js:268-282](../src/materials.js#L268-L282) arms `uCellPrev/uPrevMix` on a cell
  change; [props.js:132-140](../src/props.js#L132-L140) decays it; the shader `mix()`es two
  `probeDiffuse` calls (up to 16 taps).
- **Coupled**: `lightvis.js` bakes a densified (2×−1) per-light **visibility** grid that
  byte-replicates the probe placement ([lightvis.js:44-57](../src/lightvis.js#L44-L57)).

### Coupling map (verified by recon)

| If we change… | …this breaks / must move with it |
|---|---|
| Probe positions → non-lattice | `probeFrag` reconstruct ([shaders.js:1400-1414](../src/shaders.js#L1400-L1414)); `probeDiffuse` weights+idx ([shaders.js:842-857](../src/shaders.js#L842-L857)); `lightvis` placement replica |
| Store explicit positions | No room in hull texture (3 spare texels ≪ 32×3 floats) → **new position texture**, not a wider `HULL_TEX_W` (Adreno demotes *all* UBO reads past ~13 KB) |
| Placement, keeping ATLAS_W/ROW_H | Boot guard compares only atlas/lightmap `w,h` ([main.js:698-701](../src/main.js#L698-L701)) → a **stale `atlas.bin` loads silently**. Need a probe-layout hash + version bump |
| Probe count > 32 / tile size | Overflows the fixed 96×48 probe block; `buildHullTexture` does *not* assert probe count |
| Remove `uCellPrev/uPrevMix` | `setMaterialCell` is **double-duty** — it also swaps the per-cell spot-light set and keys `lightvis` on `uCell`. Keep `uCell` + the light swap; remove only the diffuse crossfade |

---

## 2. Key insight — portal-recursive baking makes the graft continuous

The adversarial pass found the naïve graft's fatal flaw: adjacent cells' probes are baked
independently (each convolved in its own hull from its own capture point), so at a shared
portal the two fields **disagree** — grafting them yields a two-valued seam, the very artifact
the graft was meant to remove.

**The fix (per your steer): bake each probe with portal recursion.** When a convolution sample
ray exits through a portal (not a solid wall), continue the raymarch into the *neighbor's* hull
and sample the *neighbor's* radiance — exactly the traversal the specular path already does
([shaders.js:433-497](../src/shaders.js#L433-L497)). Consequences:

- A probe in cell A near a door and a probe in cell B near that door now integrate the **same
  underlying radiance** through the portal. As both approach the portal plane their integrals
  converge → **the two fields agree at the boundary** → the grafted interpolation is continuous,
  with **no separate seam probes** and no extra storage.
- Bonus: near-door probes get *correct parallax* on the neighbor room instead of the flattened
  cube-capture-through-the-door — a strict quality win independent of continuity.
- It's offline, reuses existing traversal code, and — critically — **only re-runs the `matProbe`
  pass**: the warp origin `h0` is per-cell so radiance LODs are position-independent; no cube
  re-capture, no mip re-prefilter. Re-optimizing placement is cheap.

The bake solves **value consistency**. The runtime graft (below) solves **connectivity**. Both
are needed; together they give a genuinely continuous unified grid.

---

## 3. Target architecture

A single **portal-connected probe complex**:

- **Per-cell deformed lattice** — keep a topological `i×j×k` lattice per cell (so
  tetrahedralization stays a trivial per-cube split), but probe **positions are explicit** and
  optimizer-driven. Dims re-budgeted per cell to include a vertical interior layer, product ≤ 32
  (e.g. 3×3×3 = 27, or 4×3×2 = 24).
- **Explicit positions** in a dedicated `RGBA32F` position texture keyed `(cell row, probe idx)`
  — mirrors how the atlas is keyed; stays **out** of the shared hull UBO.
- **Portal-recursive irradiance bake** (§2) for cross-portal value consistency.
- **Graft = portal-aware tetrahedralization**: tetrahedralize each cell's deformed cubes, then
  **stitch** portal-facing probe faces of adjacent cells with bridging tets, creating an edge
  only where the connecting segment passes the portal (predicate below). Tet connectivity is
  **per-face**, so multi-portal corners stitch to each neighbor independently — the case that
  breaks ghost-probe schemes.
- **Runtime = CPU per-prop tet-locate + in-shader barycentric** over 4 explicit probe tiles.
  Barycentric is C0 across shared tet faces; combined with §2's value consistency the door
  handoff is seamless. Fixed 4 taps (down from 8, and no 16-tap crossfade). The time crossfade
  and all door special-casing are deleted.
- **`lightvis` decoupled** to its own regular grid (visibility is a shadow-boundary concern,
  independent of irradiance placement; keeps a regular `bbox+dims` stored for it).

**Portal-passage predicate** (bake-time stitch gate *and* runtime blend gate; uses only existing
data — [level.js:537-573](../src/level.js#L537-L573)):

```
segmentThroughPortal(pA in A, pB in B, portal po):   // po.neighbor == B
  pl = A.planes[po.planeIndex]                        // {n,d}
  sA = dot(pl.n,pA)+pl.d;  sB = dot(pl.n,pB)+pl.d      // sA>0 inside A, want sB<0
  if sameSign(sA,sB): reject
  t = sA/(sA-sB);  X = pA + t*(pB-pA)                  // hit on the wall plane
  for ep in po.edgePlanes: if dot(ep.n,X)+ep.d < -eps: reject   // inside the rect?
  accept
```

Door portals coincide exactly across A/B (mid-plane, `planeShift = WALL_T/2`), so the test is
symmetric. **Skip the sky imposter portal** (N-gon aperture, hollow cell, no props). **Do stitch
virtual open-plan portals** (L-bend, pillar ring) — props cross them and they need continuity
(the recursive bake makes their values agree too).

---

## 4. Decisions locked / defaults assumed

Locked from discussion:

- **Continuity mechanism**: portal-recursive baking (not seam probes, not a spatial blend of
  disagreeing fields).
- **Placement DOF**: deformed lattice (explicit positions, fixed per-cell topology).
- **Vertical**: re-budget dims for a vertical interior layer, per-cell product ≤ 32.

Defaults I'll assume unless you say otherwise (flagged in-plan, easy to change):

- **Optimizer objective**: the literal "maximize radiance-delta/distance" is degenerate
  (maximized by spacing→0). Implement its well-posed form — **equidistribution under a fixed
  probe budget**: place divisions so a monitor field `m = 1 + α·|∇L̂|` is equidistributed,
  which clusters probe planes/vertices at high-gradient (light-boundary) locations. `α` is a
  dial; **α = 0 reproduces today's uniform grid** (zero-risk fallback). `L̂` = scalar luminance
  of a **decoupled** dense reference irradiance field (evaluated with the same warp+LOD-2 gather
  as `probeFrag`, so it's placement-independent → a single-pass solve, no bake↔optimize loop).
- **Optimizer runs offline**, before `buildHullTexture`/`Baker` (the only `probeGrid` consumers,
  plus `lightvis`).
- **Recursion depth** in the probe bake: 1 hop (diffuse two rooms away is negligible); constant,
  revisit if a doorway-through-doorway prop looks wrong.
- **Large props (>1 m)**: per-*object* tet-locate (small far-vertex error on a smooth field);
  escalate to per-vertex locate only for the specific prop if a pop is visible.

---

## 5. Staged plan

Each stage is independently verifiable with the headless harness (`?shot/steps/blend/debug`,
sequential shots only — parallel SwiftShader Chromes froze the machine) and delivers value alone.

### Stage 0 — Scaffold & measure  *(no behavior change)*
- **Probe debug view**: draw probe positions, their irradiance, and the monitor/gradient field
  (net-new — `debug.js` has *zero* probe references today; `uDebugMode==3` shows the per-cell IRR
  tile, not probes). Prerequisite for trusting the optimizer.
- **Probe bench rung / taps toggle**: the bench ladder has no probe rung, and the fill methodology
  measures per-pixel specular, not the per-vertex probe path. Add an A/B toggle for 4/8/16-tap
  variants so every later claim is measured, not a prior.
- **Offline interpolation-error harness**: L2 of (interpolated field − dense reference) per cell,
  for uniform vs optimized placement. This is the gate for Stage 3.
- **Exit**: can see probes, measure taps, and score a placement. Nothing else changed.

### Stage 1 — Portal-recursive probe bake  *(value consistency)*
- Add neighbor recursion to `probeFrag`'s per-sample raymarch
  ([shaders.js:1431-1438](../src/shaders.js#L1431-L1438)), reusing the specular portal logic
  (bitmask skip → portal scan → `edgePlanes` inside test → sample neighbor's tile with neighbor's
  `h0`). Diffuse needs no silhouette-blend — hard-recurse inside the polygon, sample local on a
  solid wall.
- Make the 0.25 m inward clamp **portal-aware**: clamp against solid walls only; let boundary
  probes sit on/near a portal plane (needed so both sides have probes *at* the seam).
- Keep the current uniform grid and (temporarily) the existing handoff.
- **Verify**: at a doorway, sample A's field and B's field at the shared plane — they should
  converge (measure the delta before/after). Near-door prop diffuse visibly improves. Re-bake is
  `matProbe`-only.
- **Exit**: cross-portal field delta at the plane is below a JND; this proves your core idea
  before any topology/interp rework.

### Stage 2 — Unified grafted interpolation  *(uniform positions)*
- Introduce the **explicit position texture**, initialized to the *current* lattice (isolates the
  interp/topology change from placement).
- Build the **portal-aware tet mesh** at load: per-cube split + portal-face stitching gated by the
  predicate (§3). Robust orientation predicates; cull degenerate tets; assert the mesh covers every
  prop spawn point; nearest-tet fallback for gaps/concave corners.
- **CPU per-prop tet-locate** (walk from last tet, seeded by `findCell`; <14 props → negligible),
  writing 4 `(tileOrigin, worldPos)` to all of a prop's materials (mirror the `p.mats` loop).
- **Shader**: replace `probeDiffuse`'s 8-corner cell-local trilinear with barycentric over the 4
  uploaded tiles (drops cell-local atlas addressing → per-vertex 4 taps). Update both the vertex
  path ([shaders.js:909-912](../src/shaders.js#L909-L912)) and the fragment path
  ([shaders.js:1165-1168](../src/shaders.js#L1165-L1168)).
- **Delete** `uCellPrev/uPrevMix` and the decay ([materials.js:201-202,271-272](../src/materials.js#L201-L202),
  [props.js:139](../src/props.js#L139), shader mixes). Keep `uCell` + the per-cell light swap.
- **Verify**: walk a prop (incl. the 1.4 m cart / a cube's flat face) through a door and a
  multi-portal corner at `?shot` poses — smooth ramp, **no 0.2 s temporal pop**, one rule
  everywhere. Bench: 4-tap interior vs old 8/16.
- **Exit**: seamless handoff with the uniform grid; door special-casing is gone.

### Stage 3 — Deformed-lattice optimizer + vertical re-budget  *(gated on Stage 0 metric)*
- Greedy optimizer moves the explicit positions (equidistribution of `m = 1+α·|∇L̂|`), with
  **hard constraints**: non-inversion (project moves back to valid cubes), min spacing, in-hull.
  Re-budget per-cell dims for a vertical interior layer (≤ 32).
- **Serialize** positions (`baked/probes.bin` or manifest) + **bump manifest version and add a
  probe-layout hash** so a stale `atlas.bin` hard-fails. Wire the `?recube` path (matProbe-only
  re-bake).
- **Decouple `lightvis`** to its own regular grid (keep a regular `bbox+dims` stored;
  [shaders.js:919-940](../src/shaders.js#L919-L940) reads the decoupled grid, not moved probes).
- **Gate**: ship the optimizer only if the Stage-0 L2 metric shows a real win; keep `α` a dial with
  `α=0` = uniform fallback. Expectation-setting: diffuse is hemisphere-convolved (smooth) and props
  are small, so the win may be concentrated on the strong **vertical** gradient (hence the
  re-budget) and on saturated colored bounce — verify, don't assume.
- **Verify**: re-bake, diff prop-lit `?shot`s vs the Stage-2 baseline; deliberately skip a re-bake
  and assert the hash guard now *refuses* the stale atlas.
- **Exit**: measured placement win, seamless handoff preserved, no stale-load hole.

---

## 6. Risk register

| Risk | Severity | Mitigation | Stage |
|---|---|---|---|
| Two-valued portal seam (grafting disagreeing fields) | was blocker | Portal-recursive bake (§2) + C0 barycentric graft | 1,2 |
| Cross-cell atlas addressing (tet spans cell rows) | major | Upload 4 explicit `(tileOrigin,pos)`; drop cell-local addressing | 2 |
| Tet inversion when optimizer moves nodes | major | Non-inversion projection + min-spacing + robust predicates; cull + cover-assert | 3 |
| Large props (1.0–1.4 m) span a tet | major | Per-object locate (small error on smooth field); per-vertex only if a pop shows | 2 |
| Coverage gaps / concave corners | major | Nearest-tet/nearest-probe fallback; assert coverage of spawn points at bake | 2 |
| Stale `atlas.bin` loads silently | major | Manifest version bump + probe-layout hash + serialized positions | 3 |
| `lightvis` silently desyncs from moved probes | major | Decouple to its own regular grid | 3 |
| Adreno ~13 KB UBO cliff (regresses *all* shaders) | major | Positions in a **dedicated texture**; per-prop tet data as small per-material uniforms; never widen `HULL_TEX_W` | 2,3 |
| Optimizer payoff marginal for smooth diffuse | major | Gate on offline L2; vertical re-budget targets the dominant gradient; `α=0` fallback | 0,3 |
| Removing crossfade unmasks an AO/spec pop at handoff | minor | AO/spec already switch on `uCell` with no fade and are tolerated; verify at `?shot` handoff poses | 2 |
| Vertical re-budget pushes a big room > 32 probes | minor | `dimFor` keeps per-cell product ≤ 32 (e.g. 3×3×3); assert probe count at bake | 3 |

---

## 7. File-by-file change map

| File | Stage(s) | Change |
|---|---|---|
| `debug.js` | 0,3 | Probe/monitor-field debug view; handoff color-by-weight view |
| `perf.js` / bench scripts | 0 | Probe bench rung / taps toggle |
| *(new)* offline error tool | 0 | Interpolation-L2 harness (uniform vs optimized) |
| `shaders.js` `probeFrag` | 1,3 | Portal-recursive convolution; read explicit positions |
| `level.js` | 1,3 | Portal-aware inward clamp; greedy optimizer (before `buildHullTexture`); per-cell dims re-budget; CPU segment-through-portal helper |
| `shaders.js` `probeDiffuse` + prop programs | 2 | Barycentric over 4 uploaded tiles; drop cell-local addressing; both vertex + fragment paths |
| *(new)* tet builder + `props.js` | 2 | Portal-aware tet mesh at load; per-prop tet-locate → 4 tiles/positions to `p.mats` |
| `materials.js` | 2 | Remove `uCellPrev/uPrevMix`; add per-prop tet uniforms; **keep** `uCell` + light swap |
| `props.js` | 2 | Replace `uPrevMix` decay with tet-locate + upload |
| *(new)* position texture | 2,3 | `RGBA32F` keyed `(cell,idx)`, on UBO + texture paths; **not** in `HULL_TEX_W` |
| `hulldata.js` | 3 | Store regular `bbox+dims` for decoupled `lightvis`; optional per-cell flags in spare texels |
| `bake.js` | 1,3 | `matProbe` binds the position sampler; matProbe-only re-optimize |
| `lightvis.js` | 3 | Decouple to own regular grid |
| `bakedio.js` / `main.js` | 3 | Serialize positions; manifest version + probe-layout hash guard; `?recube` wiring |
| `atlas.js` | — | Unchanged if count ≤ 32 & tile size fixed (the reason to keep topology bounded) |
| `culling.js` | — | Unchanged (no probe coupling) |

---

## 8. Open items to settle during implementation

- Confirm the **objective metric** (§4 default: equidistribute `1+α·|∇luminance|` of a decoupled
  field). Alternatives: per-channel gradient (colored-bounce boundaries) or including a
  visibility-gradient term (but sharp shadow edges already live in `lightvis`).
- Per-cell **dims re-budget** shape (3×3×3 vs 4×3×2 vs optimizer-chosen under ≤32).
- Whether any prop needs **per-vertex** tet-locate (decide from Stage-2 shots of the cart/console).
