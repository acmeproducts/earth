# Central Oslo walking investigation — 2026-09-16

The test is `yarn test:oslo-walk`. It spawns at 59.9116, 10.7334, facing west,
and uses the normal walker and collisions until net horizontal displacement is
at least 100 m. The normal 33×33 terrain / 2×2 detail settings are retained.
Seed, date, time and wind are fixed. No far-terrain settling delay is inserted.

Every walking frame is retained in `artifacts/oslo-walk/<timestamp>/results.json`.
There are also browser errors, a finish screenshot, and optional CPU profiles
and Chrome timelines. The default limit is 33.33 ms; the command exits with an
error if any frame exceeds it. Completion of the route alone is not a pass.

## Changes

- Terrain collision meshes share the visible terrain's buffers, with small
  row-based submeshes for collision/picking bounds. The visible terrain remains
  one submesh. This avoids scanning a complete 32,768-triangle tile on each
  ground ray and walker collision check without increasing visible draw calls.
- Lake filtering sends original building footprints to its worker. Its
  cumulative polygon subtraction already handles overlaps and duplicates;
  merging entire provider tiles and inferring building uses on the main thread
  was unnecessary. A captured lake preparation call took 1,108.5 ms before this
  change, including a 990.9 ms footprint merge.
- Initialization prepares a frame and waits for a one-pixel GPU readback before
  reporting Ready. This drains initial rendering work behind the loading screen.
- The test now sets the initial camera heading during initialization. Earlier
  versions introduced a westward turn when the walk started, adding first-use
  rendering work beyond the requested forward walk.
- Building CustomMaterials reuse shader program keys when their complete GLSL
  and binding signatures match. Material uniforms and ownership remain separate.
  Four redundant building program links in a traced walk disappeared after this
  change. The per-material resolver also caches its signature lookup.
- Road texture pixels are cached by surface style. Previously every streamed
  batch regenerated identical 128-by-128 noise textures, including unused gravel
  octaves for asphalt. A CPU profile attributed 25–40 ms timer callbacks to this
  work. Each tile still owns its GPU textures; disposal behavior is unchanged.
- Startup prepares the thin-instance shader variant of allocated vegetation
  meshes whose initial LOD instance count is zero. Counts are restored even on
  compilation failure, before any frame is rendered.
- Lake obstacle preparation rejects unrelated source bounds before projecting
  and cloning every vertex. Tests retain obstacles against the full provider
  lake (including outside the terrain tile), and expand road bounds by physical
  carriageway width. The preceding trace showed a 15.8 ms worker serialization
  call during a 45.9 ms frame.
- Planned roads and shoulders yield within batches, including polygon fragments
  and normal sampling. A subsequent combined profile identified a 99.7 ms task
  in this construction when another detailed tile streamed in. Tests compare
  complete geometry with and without yielding on uneven terrain, verify hidden
  partial batches, and verify cleanup on cancellation.
- Terrain clipping also yields within individual polygons, including empty cells
  inside a diagonal polygon's bounding box. This bounds the work between yield
  checks rather than allowing one large polygon to monopolize a loading slice.
  Async/sync geometry equality and cancellation tests cover this path.
- Land-cover overlays reuse decoded polygons by immutable provider data and tile
  coordinates. A later profile found 11 ms of repeated `toGeoJSON/loadGeometry`
  decoding in distant-tree construction. The weak cache preserves per-sampler
  fallback behavior and invalidates for replacement data or coordinates.
- Building composition now caches by the provider-data sequence, rather than
  the temporary array wrapper returned for each terrain tile. Streaming
  diagnostics identified a repeated 148.3 ms footprint merge at 61 m. A weak
  trie lets neighboring application tiles reuse composition without retaining
  unloaded providers; the regression test supplies fresh wrappers at each LOD.
  Cache reuse alone did not fix first-time provider composition: a subsequent
  run still spent 133.5 ms merging a newly encountered provider. Composition now
  runs in a dedicated worker before terrain planning, and stores its result in
  that shared cache. Concurrent requests share the pending result; failures clear
  it for retry. Location resets and disposal also reset/dispose the worker.

## Results and limitations

Selected saved runs (all paths below are under `artifacts/oslo-walk/`):

| Run | Configuration | Distance | >33.33 ms | >50 ms | Worst frame |
| --- | --- | ---: | ---: | ---: | ---: |
| `2026-09-16T15-10-31-595Z` | Original application, focused, CPU profile, turn at start | 100.11 m | 12 | 8 | 696.4 ms |
| `2026-09-16T15-13-49-005Z` | Collision/lake fixes, CPU profile, turn at start | 100.25 m | 19 | 14 | 748.8 ms |
| `2026-09-16T15-16-24-249Z` | Collision/lake fixes, no profiler, turn at start | 100.09 m | 46 | 39 | 666.7 ms |
| `2026-09-16T15-19-52-128Z` | Collision/lake fixes, Chrome timeline | 100.16 m | 34 | 24 | 757.7 ms |
| `2026-09-16T15-27-10-465Z` | Diagnostic: DirectComposition disabled, timeline | 100.22 m | 130 | 13 | 1,117.3 ms |
| `2026-09-16T15-32-49-049Z` | GPU readiness added, still turns at start, timeline | 100.09 m | 28 | 6 | 686.9 ms |
| `2026-09-16T15-36-34-595Z` | GPU readiness and initial west heading, no profiler | 100.03 m | 26 | 10 | 127.0 ms |
| `2026-09-16T15-46-27-088Z` | Before building shader sharing, timeline | 100.02 m | 90 | 62 | 370.5 ms |
| `2026-09-16T15-50-04-030Z` | Shared building shaders, timeline | 100.04 m | 5 | 4 | 123.4 ms |
| `2026-09-16T15-53-21-967Z` | Shared building shaders, no profiler | 100.02 m | 15 | 8 | 247.9 ms |
| `2026-09-16T15-55-28-920Z` | Resolver lookup cache, CPU profile and timeline | 100.01 m | 65 | 41 | 510.4 ms |
| `2026-09-16T16-08-34-316Z` | Road pixel cache, no profiler | 100.04 m | 1 | 1 | 55.3 ms |
| `2026-09-16T16-11-17-378Z` | Inactive vegetation shader preparation, no profiler | 100.01 m | 7 | 0 | 45.7 ms |
| `2026-09-16T16-13-33-294Z` | Same application, timeline | 100.08 m | 3 | 0 | 45.9 ms |
| `2026-09-16T16-17-13-383Z` | Lake source bounds culling, no profiler | 100.07 m | 7 | 3 | 213.5 ms |
| `2026-09-16T16-19-09-363Z` | Same application, detailed GPU timeline | 100.07 m | 3 | 1 | 106.4 ms |
| `2026-09-16T16-23-58-984Z` | Same application, CPU profile and timeline | 100.04 m | 69 | 46 | 1,261.6 ms |
| `2026-09-16T16-30-23-408Z` | Cooperative road geometry, no profiler | 100.04 m | 29 | 11 | 339.2 ms |
| `2026-09-16T16-49-15-081Z` | Compiler exited before browser, no profiler | 100.07 m | 13 | 3 | 83.9 ms |
| `2026-09-16T16-51-35-137Z` | Per-GL-call trace of opening section, metrics on | 100.06 m | 8 | 2 | 103.2 ms |
| `2026-09-16T16-54-14-049Z` | Normal HUD, no CPU/GPU profiler or timeline | 100.07 m | 3 | 2 | 109.9 ms |
| `2026-09-16T16-57-22-902Z` | Normal HUD, full timeline | 100.00 m | 5 | 2 | 78.2 ms |
| `2026-09-16T17-09-10-200Z` | Inner-polygon clipping yields, normal HUD, no profiler | 100.00 m | 17 | 3 | 99.1 ms |
| `2026-09-16T17-11-17-636Z` | Same build, normal HUD, CPU profile and timeline | 100.03 m | 13 | 7 | 102.6 ms |
| `2026-09-16T17-16-24-037Z` | Land-cover cache, normal HUD, no profiler | 100.09 m | 1 | 1 | 154.8 ms |
| `2026-09-16T17-18-08-586Z` | Same build, normal HUD, timeline | 100.00 m | 2 | 2 | 159.8 ms |
| `2026-09-16T17-21-06-087Z` | Same build before composition cache, CPU profile and timeline | 100.00 m | 2 | 0 | 36.6 ms |
| `2026-09-16T17-23-50-316Z` | Composition cache only, no profiler | 100.01 m | 1 | 1 | 144.4 ms |
| `2026-09-16T17-27-44-623Z` | Composition worker, no profiler | 100.09 m | 2 | 1 | 70.0 ms |
| `2026-09-16T17-29-39-142Z` | Same build, timeline | 100.09 m | 0 | 0 | 22.1 ms |
| `2026-09-16T17-31-59-511Z` | Same build, unprofiled repeat | 100.11 m | 2 | 0 | 49.1 ms |

**Instrumentation correction:** All runs through `16-51-35` implicitly enabled
the application's detailed performance HUD instrumentation, including GPU timer
queries, even when no CPU profiler/timeline was requested. Default validation now
keeps the normal HUD state; `--metrics` explicitly enables those extra counters.
Every frame interval and the normal game/render CPU samples remain recorded in
both modes. Treat this as a harness correction, not an application speedup, and
do not compare the configurations as if they were identical.

The two profiled runs measured average game work of 7.57 and 1.35 ms/frame,
respectively. Render-call averages were 2.76 and 2.69 ms. This supports the
collision CPU improvement; it does **not** establish that all visible stutters
are solved. The later unprofiled run averaged 3.10 ms of game work per frame.

The normal Windows timeline contains long `DXGISwapChainImageBacking::Present`
calls on `CrGpuMain` (roughly 300–675 ms), distinct from the game's JavaScript
callback. Other pauses occur while the GPU service executes queued WebGL work.
Worker computation is separately identified and must not be counted as main
thread blocking. Inspect CPU, GPU, browser presentation and streaming together.

Disabling DirectComposition is an explicit diagnostic option only. Chromium
[documents this switch in its source](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/ui/gl/direct_composition_support.h).
The comparison reduced normal frame rate and still failed; it is not a default
and is not claimed as an application fix.
The optional detailed GPU trace uses Chromium's
[documented OpenGL service tracing switch](https://chromium.googlesource.com/chromium/src/+/master/docs/gpu/debugging_gpu_related_code.md).

Harness corrections during the investigation included focus emulation (the
unfocused browser uses the application's larger background loading budget), a
fresh debug port/profile and owned tab, explicit browser tree cleanup, command
timeouts, and a blocked-route timeout. The initial eastward route hit a building
at 76 m and is not a successful 100 m baseline. The initialization-only failed
attempt at `15-25-09` is not a measurement. Early runs and runs with different
instrumentation/presentation settings are not directly interchangeable.
The startup-only attempt at `16-02-43` closed before any walking data was
recorded. Later harness runs retain browser stderr beside their results.
The per-GL-call diagnostic at `16-33-14` retained `results.json`, but its full
trace export timed out. It is not a clean validation run. Available system RAM
was about 2.7 GB during that diagnostic. The harness now limits per-GL-call
tracing to the first roughly two seconds and records that boundary; normal
timeline tracing and frame measurements retain their full duration. Compilation
now runs in a child process that exits before Chrome starts. Windows cleanup
terminates the owned browser tree before losing the root PID, with a bounded
graceful-close fallback. Native process inspection distinguished already-exited
process records from running test processes.
The first launch after this harness change timed out at `Page.navigate`, before
a walking measurement could begin; a built bundle was retained for retry.

The road-cache run had p50 8.4 ms, p95 11.4 ms and p99 20.9 ms. Its only frame
over the strict limit occurred at 63.08 m. It still reported 46 relative stutter
flags from the application's adaptive detector; these are separately retained
from the fixed 33.33 ms regression criterion. No passing claim should hide either
metric. Timing varies substantially between launches and instrumentation modes.
The two subsequent runs created no new shader effects during the walk. In the
traced run, two over-limit frames overlap 40.3/46.3 ms GPU command batches;
the third overlaps the worker serialization call described above.
The short per-GL-call trace exported successfully and recorded 169,147 GL events;
the slowest individual call in that captured section was about 1.04 ms. It did
not reproduce the earlier long GPU batches, and does not cover late pauses.
The first normal-HUD validation had p50 8.6 ms, p95 16.9 ms, p99 26.0 ms, three
over-limit intervals (82.8, 109.9, 34.1 ms), no new shader effects and no observed
JavaScript long tasks. Its adaptive detector still flagged 126 frames.
The next full timeline retained GPU command waits of roughly 52–75 ms, plus
a 23 ms loading timer near the end. Individual-polygon terrain clipping was
made cooperative after this capture; this does not establish that the GPU
waits are fixed.
The land-cover-cache validation completed in 10.11 seconds with p50 8.4 ms,
p95 10.5 ms and p99 14.7 ms. One 154.8 ms frame at 60.99 m coincided with
a browser-reported 149 ms long task. The relative detector flagged 19 frames.
This remains a failure despite the otherwise smooth route.
The next timeline reproduced a 152 ms timer at 60.92 m. Its synchronous
streaming stages identified 148.3 ms in merging provider building footprints.
The other slow frame overlapped a 58.2 ms GPU presentation call. A follow-up
profile did not reproduce the long merge within the measured route; this
illustrates timing variability and is not evidence of a fix by itself.
The first worker-enabled validation had no recorded JavaScript long tasks or
slow main-thread streaming stages. Two early gaps (34.2 and 70.0 ms) still failed
the limit. The following timeline run passed the fixed threshold, with p99
16.8 ms and maximum 22.1 ms, but retained 33 relative detector flags.
The unprofiled repeat failed with gaps of 33.4 ms at 74.5 m and 49.1 ms at
94.1 m. It had no recorded JavaScript long tasks, new shader effects, or slow
main-thread streaming stages. Its p99 was 20.1 ms and relative detector count
was 63. Therefore the passing trace is not a repeatable zero-stutter result.
The unprofiled run alone cannot precisely attribute those two remaining gaps;
previous traces showed GPU command/presentation waits, but that is not proof
that both latest gaps share that cause.
After the inner-polygon change, the combined trace/profile found no road-clipping
timer over 20 ms. Remaining slow timers included 24 ms of garbage collection and
the land-cover decoding above. Early GPU command batches still took 90–93 ms,
with a corresponding main-thread command flush of about 81 ms. This is evidence
of remaining work, not a passing result or proof of an exclusively driver issue.

## Validation

- `yarn typecheck`: passed.
- 48 targeted tests passed, covering terrain collision/picking and disposal,
  scene reveal ordering, walking, spawn windows, lake/road/building overlap,
  building streaming, and shared terrain materials.
- Targeted output: `.oslo-targeted-tests.log`.
- 36 targeted shader/building tests passed (`.oslo-shader-tests.log`).
- Road-cache bytes match all nine original surfaces, and shader material uniform
  isolation/disposal tests pass (`.oslo-cache-tests.log`).
- Scene readiness tests cover GPU fencing and inactive instance compilation,
  including restoring draw counts on error (`.oslo-readiness-tests.log`).
- 21 lake/building/road tests passed after source bounds culling, including
  off-tile coverage and road-width cases (`.oslo-lake-culling-tests.log`).
- Cooperative planned-road geometry, staging, cancellation cleanup, and the
  building/lake cases passed (5 tests, `.oslo-road-yields-tests.log`), followed
  by a passing type check for the production change. The uneven-terrain geometry
  comparison was added and passed after that type check.
- Full `yarn test`: 768 tests, 760 passed, 7 failed, 1 skipped
  (`.oslo-full-tests.log`). All seven failures reproduced against HEAD source
  in the four affected test files (33 tests: 26 passed, 7 failed), with unchanged
  runtime planner/image code (`.oslo-baseline-tests.log`). They are existing
  building/OSM/vegetation source assertions and an SVG expectation; no full-suite
  pass is claimed. The moved road-noise assertion now reads its new module.
- After the final terrain-clipping change, all 11 ground-clearance and building
  streaming tests and typechecking passed. The full-suite run above preceded
  the cooperative road construction changes.
- Land-cover caching: all 5 targeted tests and typechecking passed.
- Provider-composition caching: all 5 building-streaming tests and typechecking
  passed, including reuse across newly allocated provider-array wrappers.
- Composition worker integration: 6 streaming tests and typechecking passed;
  tests include cloned worker task input/output, shared pending requests,
  rendering both detail levels without main-thread recomposition, and retry.
- After the final browser repeat, 27 worker lifecycle, composition, height-band,
  cache, and geometry tests passed.
- WebGL on the local Intel Arc 140V was exercised. WebGPU was not exercised.

The strict walking test has produced a passing run, but earlier failures on the
same build and relative detector flags remain visible. Do not raise the limit,
wait for streaming to finish, or exclude inconvenient frames to obtain a pass.
A clean run certifies this finite route/configuration, not all future locations
or operating-system scheduling conditions.
