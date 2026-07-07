# GPU profiling — per-feature cost of PortalIBL

Goal: defensible ms numbers for the write-up — what the portal traversal costs
vs single-step PCCM, and what dynamic shadows / AO / reflections each cost, on
**PC** and **Quest 3**, averaged over one representative view of every cell plus
a curated worst-case set.

## The rung ladder (each rung adds ONE feature)

Every rung is separated by a **compiled** difference where a runtime toggle
would leave the cost in place (a `uSpecBoost=0` multiply or a `uOccOn=0` branch
still pays the register/occupancy footprint of the code it guards). The
`?bench` harness (`src/main.js`) and the `?benchremote` in-VR path swap whole
programs via `matsys.benchSetRung`:

| rung | program (compiled) | steps | AO | shadow | isolates vs previous |
|------|--------------------|-------|-----|--------|----------------------|
| `off`    | `noSpec` everywhere (specular chain compiled out) | 3 | 0 | 0 | cost floor (no reflections at all) |
| `pccm`   | **`pccmOnly`**: `pccmSpec` only, traversal loop + `occSegment` + `traceSpec1` dead-stripped | 0 | 0 | 0 | single-step IBL = `pccm − off` |
| `portal` | shipped tiered (matte walls, 1-hop floors, full-march glass/chrome) | 3 | 0 | 0 | **portal traversal** = `portal − pccm` |
| `ao`     | = `portal` program, runtime `uOccOn=1` | 3 | 1 | 0 | capsule AO + reflection-occlusion = `ao − portal` |
| `full`   | = `portal` program, `uOccOn=1 uOccShadow=0.85` | 3 | 1 | 0.85 | dynamic soft shadows = `full − ao` |

Why the AO/shadow rungs stay *runtime* toggles: `occSegment` is compiled into
`portal`/`ao`/`full` alike, so occupancy is constant across those three and the
`ao`/`shadow` deltas are pure *work*. The register-footprint confound only
exists at the `off`/`pccm`/`portal` boundaries — exactly where compiled
variants are used.

Why `pccm` needs its own compiled variant (not `uMaxSteps=0`): setting steps to
0 on the full-march program runs the loop zero times but keeps its register
allocation and occupancy ceiling, so PCCM would read as expensive as the portal
path and *understate* the traversal's true marginal cost. `pccmOnly` forces the
reflective call site to `pccmSpec` alone (see `PCCM_ONLY` in `src/shaders.js`),
which lets the GLSL compiler dead-strip the traversal machinery → a genuinely
lean single-step program.

Derived costs (all **paired per-pose** deltas, so the fixed scene cost cancels):
`reflections/IBL = pccm−off`, `portal traversal = portal−pccm`,
`AO+refl-occ = ao−portal`, `dyn shadows = full−ao`, `ALL = full−off`.

## View sampling

`?bench` generates one **seeded** camera per occupiable cell (14; the hollow
`sky` cell is skipped): a point 0.2–0.6 of the way from the cell centroid toward
a random footprint vertex (stays inside the convex hull), eye height 1.6 m,
random yaw + slight pitch. Same seed → identical poses on PC and Quest (listed
in the result JSON `meta.poses`). Plus a curated worst-case set (gallery props,
pillar-hall cuts, glass-at-face, L-room cut, exhibit hall, rotunda marble) — the
frame-budget ceiling that actually determines whether VR holds rate.

## PC — real per-frame GPU timer

`EXT_disjoint_timer_query_webgl2` gives true GPU ms (`src/perf.js`
`gpuBegin`/`gpuEnd`/`gpuHarvest`, raw median-of-N via `collectStart/Stop`).
Robustness measures baked into `?bench`:

- **Frame-tight cyclic interleave**: a pose's whole rung ladder is cycled in
  ~1 s bursts (`K=8` frames each), repeated `CYCLES` times, so DVFS/OS jitter is
  common-mode between the paired rungs and cancels in the delta. (Measuring each
  rung in a separate seconds-long window let clock drift swamp the ~0.1 ms
  signal.)
- **Deterministic prop wobble** (`?benchjitter`, default 1.5 cm): props are NOT
  stepped by chaotic physics (that drifted the occluder set and swamped the
  ~0.1 ms reflection deltas), but they are NOT frozen either — a truly at-rest
  scene hits `dynocc`'s exact-change early-out and the dynamic AO/shadow layer
  **never regenerates**, no-op'ing the very cost we measure. Instead each prop
  wobbles on a small deterministic path; the measured `K` frames of every rung
  step through the SAME `1..K` wobble sequence, so props are byte-identical per
  frame-index across rungs (clean reflection delta) yet move every frame (the
  dyn layer regenerates → real AO/shadow cost). The layer splat is gated to the
  `ao`/`full` rungs (`uOccOn>0`) so its per-frame cost attributes to the feature,
  not the `portal` baseline.
- **Fixed high resolution** (default 2560×1440, `benchw`/`benchh`): reflection
  cost is per-pixel FILL; at panel resolution it sits under the timer noise
  floor. State the resolution in the write-up.

Run: `node serve.mjs 8123` (one terminal), then
`node scripts/bench-pc.mjs [--set both|cells|worst] [--cycles 6] [--k 8] [--w 2560] [--h 1440]`.
It launches a **foreground** real-GPU Chrome window (do not minimize — background
tabs throttle rAF and stop timer queries), waits for the self-uploaded
`baked/bench-pc.json`, and runs the analyzer.

## Quest 3 — precise via ovrgpuprofiler render-stage traces

`ovrgpuprofiler -t1` reads the GPU's own hardware stage timestamps per surface
(the precise timing the burn-sweep could only approximate). The parser takes the
scene's `Render` stage from the large MSAA4 browser surface, median over ~1 s of
frames, isolated from compositor `Preempt`. Two complementary drivers — both run
the same rung ladder with prop wobble active (`?benchjitter`), and write the same
schema for the analyzer. Both simulate proximity so the headset can sit on the
desk; both cycle rungs tightly and sample GPU frequency (metric 2) as a thermal
guard.

**In-VR (stereo — the shipped frame cost): `bench-quest-vr.mjs`.** Real WebXR
eye buffers (true stereo, foveation, reprojection). The pose is head-driven, so
you walk to a cell and hold still while the driver toggles the rung live via
`?benchremote` and traces the eye buffer.
1. `node scripts/bench-quest-vr.mjs`. It force-stops the browser, enables
   detailed mode (must precede launch), opens `?benchremote=1`.
2. Don the headset, click **Enter VR**, walk to a cell, hold still, press Enter,
   type the cell name. Repeat per cell; `done` to finish.
Output `baked/bench-quest-vr.json`. These are **per-frame (both eyes)** numbers —
report stereo. A few cells (a hall, a single room, an exhibit) anchor the
frame-budget claim (11.11 ms @90 Hz, 13.89 ms @72 Hz).

**Flat automated (no headset — an eye-res mono proxy): `bench-quest.mjs`.** The
flat panel is only 1280×670, but the WebGL *canvas* is sized to eye resolution
(`benchw=2064 benchh=2208`), so the Adreno does full-res MSAA4 fill that the same
trace parser reads. The driver (`?bench&benchremote`) paces both pose and rung
over all 14 cells — fully automated. Numbers are **per eye (mono)**; a faithful
proxy for the per-feature deltas, but real in-VR renders two eyes (~2× frame,
minus foveation), so use the in-VR run for absolute frame-budget claims.
Run `node scripts/bench-quest.mjs [--set both|cells|worst] [--cycles 3]` →
`baked/bench-quest-gpu.json`.

Thermal protocol: start cold; the per-view tight interleave keeps each paired
delta clean even as the headset warms; the driver flags GPU-frequency drift.
(In a 9-min flat sweep the clock held 599 MHz throughout, cycle-to-cycle
agreement to two decimals — the thermal robustness the burn-sweep lacked.)

## Analysis

`node scripts/bench-analyze.mjs baked/bench-pc.json [baked/bench-quest-gpu.json ...]`
→ absolute per-rung frame ms, per-feature paired deltas (mean ± 95% CI, range,
n), per-cell breakdown, and `baked/bench-summary.{json,csv}` for plotting.
