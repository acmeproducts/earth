# Vista performance investigation

Run `yarn test:vista` for the full test, or add `--profile` for a diagnostic CPU
profile. `--seconds=90` gives a shorter loading sample. The default is 300 seconds
so the test includes populated scenery, not only the first terrain pass.

The fixture uses central Oslo, seed 1161908820, September 5 at 14:00, zero wind,
the normal 33 x 33 terrain window and 2 x 2 detail window, and a 997 x 731 WebGL
canvas. Chrome runs in an isolated profile with focus emulation. There is no
settling delay before recording. Results, every frame, loading coverage, browser
errors and a screenshot are retained under `artifacts/vista-performance`.

The test requires complete terrain and scenery coverage and p95 frame intervals
at or below 33.33 ms during the whole run, the final 30 seconds, and the populated
portion. It retains individual stalls and maxima; passing this sustained-frame
criterion does not certify zero stutter. Profiling adds overhead, and the fixed
viewport does not establish performance at larger resolutions or on other GPUs.

## Changes

- Seasonal refresh returns immediately when the calendar day is unchanged.
  The baseline profile spent about 7.8 seconds resampling mean terrain elevation
  over a 90-second run. Newly created layers still receive their snow depth,
  and date changes still update existing terrain and invalidate vegetation.
- Completed foreground tile builds request scheduling on the next rendered
  frame instead of waiting for the 250 ms camera-window poll. Background
  continuation, the shared CPU budget and two-build concurrency limit remain.
- Static far terrain, water, buildings, roads and trees freeze their transforms
  and use Babylon's frustum test before readiness and LOD evaluation. Dynamic
  meshes keep the normal path. Tests cover camera turns, new tiles, disposal
  and explicit culling overrides.
- Road materials and textures are shared per scene and surface style. Unloading
  a tile detaches its shared material before disposal. Snow remains per mesh.
  Tests cover reuse, surviving neighboring tiles and scene disposal.
- Far terrain, skirts and roads batch by material and vertex layout within
  4 x 4 tile regions. Sources stay resident for terrain sampling and collisions.
  Fades, unloading and incompatible snow depths restore individual meshes;
  uploads are limited to one group per update. Custom shader attributes are
  preserved. This reduces draw calls without removing geometry or shortening
  the viewing distance, but sends extra edge-of-frustum geometry to the GPU.
- Static frustum results are cached until the camera transform or mesh world
  matrix changes. Settled batches skip validation when no fades or pending
  membership changes exist; calendar updates explicitly revalidate snow.

## Diagnostic iterations

All entries here used the CPU profiler. Frame measurements are from the final
30 seconds. Tile counts differ between iterations; do not interpret a frame-rate
change caused by more loaded scenery as a regression by itself.

| Artifact timestamp | Duration | Change | Terrain/scenery | FPS | p95 ms | Game CPU ms | Render CPU ms |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 15-25-46-865Z | 90 s | Baseline | 512 / 4 | 142.8 | 11.4 | 1.87 | 3.82 |
| 15-28-37-662Z | 90 s | Seasonal refresh | 518 / 4 | 167.2 | 9.0 | 0.48 | 3.44 |
| 15-30-51-721Z | 90 s | Scheduler refill | 1089 / 20 | 82.2 | 17.8 | 1.31 | 7.75 |
| 15-33-06-708Z | 180 s | Longer populated-scene investigation | 1089 / 547 | 32.8 | 44.8 | 2.17 | 20.07 |
| 15-38-30-685Z | 180 s | Early static culling | 1089 / 498 | 34.5 | 43.5 | 2.24 | 15.85 |
| 15-43-17-491Z | 180 s | Shared road materials | 1089 / 498 | 48.1 | 27.2 | 1.96 | 13.29 |

The original 90-second criterion only required terrain coverage; the scheduler
iteration passed that limited criterion. It did not exercise a completed vista.
The test was expanded to require scenery too, and to retain a populated-phase
summary. The 180-second runs did not finish scenery and therefore failed the
expanded criterion, even when their frame-time percentile passed.

Road sharing reduced late-run frames over 33.33 ms from 222 to 6 in the two
180-second runs ending with 498 scenery tiles. Those runs still had isolated
stalls: maxima of 274.2 ms and 156.3 ms across their full durations, respectively.
Tree atlas generation remains a significant loading cost.

## Full-range validation

The unprofiled 300-second run `2026-09-17T15-47-06-710Z`, before batching,
finished with 1089 terrain tiles and 906 scenery tiles. Its last 30 seconds
averaged 26.9 FPS with p95 46.0 ms and 1617 draw calls at the final coverage
sample. It failed both the frame-time and completed-scenery criteria.

With batching (`2026-09-17T15-58-59-586Z`), all 1089 scenery tiles finished at
276.8 seconds. The complete view submitted 967 draws, with a populated-phase
average of 34.0 FPS and p95 33.9 ms. The final 30-second window, which still
included loading, had p95 40.2 ms. This was an improvement, not a passing run.
The follow-up adds the unchanged-view culling cache and settled-batch fast path.

The final unprofiled run, `2026-09-17T16-07-34-916Z`, passed the full test:

- Terrain completed at 77.3 seconds; all 1089 scenery tiles completed at 270.7 seconds.
- Populated phase: 35.8 FPS, p95 32.9 ms, p99 35.3 ms, maximum 40.3 ms.
- Final 30 seconds: 35.8 FPS, p95 32.9 ms, 42 frames over 33.33 ms, none over 50 ms.
- Full 300 seconds: p95 31.3 ms, maximum 127 ms, 77 frames over 50 ms.
- Completed view: 967 draws and approximately 1.25 million submitted triangles.
- No browser errors; focused/visible WebGL on NVIDIA GeForce RTX 5070 Ti.

Compared with the earlier unprofiled five-minute run, late-run FPS increased
from 26.9 to 35.8 while more scenery was loaded (1089 versus 906 tiles), and
draw calls fell from 1617 to 967. These are loading-run comparisons, not
identically populated before/after steady-state measurements. A single passing
run does not establish a repeatable zero-stall result, and the cold forest-atlas
pause remains apparent in the coverage history.

Validation also included TypeScript checking, 73 focused tests, and follow-up
cache and batch lifecycle tests. The final screenshot was inspected. Source
terrain and collision picking remain intact when render batches replace visible
meshes. Raw benchmark artifacts are retained locally and ignored by Git.

The runtime checks use an autumn date. Snow-depth compatibility and daily
refresh are covered by unit tests, but winter performance is not measured.
