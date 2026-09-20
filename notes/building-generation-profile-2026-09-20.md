# Building generation profile, 2026-09-20

Profiled the current working tree, including its existing uncommitted renderer
and interior-priority changes. No application code was changed for this investigation.

## Findings

1. Interior completion is heavily limited by the eight-step frame cap in
   `src/procedural/InteriorStreaming.ts:104`, even when the 2 ms budget is unused.
   The large apartment fixture took 2,494 frames with only 1,139 ms of callback
   CPU time: an average 0.457 ms per frame. At 60 FPS that is 41.6 seconds.
   `buildInteriorChunks` yields separately for geometry, buffer compaction,
   merging, and activation, so a step is often very small.
2. The current working-tree changes make exterior generation wait for *all*
   nearby interior jobs via `yieldToNearbyInteriors` in
   `src/procedural/InteriorStreaming.ts:150`, called from
   `src/world/OpenStreetMap.ts:755`. This includes far buildings and each
   asynchronous detailed compile yield. Long interior completion therefore
   also delays surrounding exteriors; moving between nearby jobs can prolong it.
   This propagation is established by code inspection, not a browser trace.
3. Furniture geometry is the largest sampled interior CPU cost. Across the
   synthetic benchmark, samples under `advanceInteriorFrame` totaled 4,443 ms:
   furniture creation accounted for about 1,749 ms (39%), batch flushing
   844 ms (19%), and interior walls 498 ms (11%). Furniture repeatedly calls
   `VertexData.CreateBox` for individual components, then transforms/copies
   their buffers. Batch flushing merges geometry and constructs materials.
   These are inclusive sampled costs; do not add nested stack entries.
4. Complex exterior planning remains costly even with workers. The existing
   real-map benchmark produced 79,739 vertices and took 2,377 ms synchronously
   versus 2,650 ms using the worker. The worker performed 40 tasks totaling
   1,670 ms of reported work. Maximum main-thread timer gap fell from 2,377 ms
   to 14.5 ms. Workers improve responsiveness, but do not eliminate generation
   latency. This was one run per mode, including worker startup.

## Synthetic Baseline

Babylon 7.54.3 NullEngine, one warm-up plus three measured runs per fixture,
CPU profiler enabled. Medians:

| Fixture | Exterior CPU ms | Interior callback CPU ms | Interior frames | Seconds at 60 FPS |
| --- | ---: | ---: | ---: | ---: |
| House 12 x 10, 2 floors | 12.97 | 15.76 | 40 | 0.67 |
| Apartments 30 x 16, 4 floors | 28.35 | 122.59 | 302 | 5.03 |
| Apartments 60 x 40, 8 floors | 104.81 | 1139.24 | 2494 | 41.57 |
| Warehouse 60 x 40 | 16.61 | 19.62 | 61 | 1.02 |

## Step-Cap Experiment

Used a Node module load hook to replace only `INTERIOR_STEPS_PER_FRAME` at
runtime. Both arms used the same hook, no CPU profiler, one warm-up and three
measured large-apartment runs; the 2 ms budget stayed unchanged.

| Cap | CPU ms | Frames | Seconds at 60 FPS | Slice p95 ms | Worst slice ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| 8 | 1368.26 | 2512 | 41.87 | 1.96 | 6.37 |
| 64 | 1321.19 | 638 | 10.63 | 3.05 | 6.14 |

CPU, frames, and p95 columns are medians; worst slice is the maximum across
measured runs. The higher cap reduced frames by 74.6% with similar total CPU.
It spends more of the time budget, but raises typical slice duration. The
budget is cooperative and cannot preempt a single operation or GC pause.
This is evidence for tuning scheduling, not a browser-validated setting.

## Next Changes To Consider

- Replace the restrictive step cap with a time-budget-led policy and a larger
  emergency cap, then validate frame times in a rendered scene.
- Give exteriors a bounded share of work instead of waiting for the entire
  nearby interior queue to drain.
- Cache primitive box vertex data and transform it into furniture buffers;
  investigate material reuse across interior merge batches.
- Profile the complex building worker separately before changing its planners.

## Reproduction And Artifacts

```powershell
yarn node --cpu-prof --cpu-prof-name=building-generation.cpuprofile --import ./tests/register-typescript.mjs scripts/benchmark-building-loading.mjs --samples=3
yarn node --import ./tests/register-typescript.mjs scripts/benchmark-building-planning.mjs
```

Local artifacts: `building-generation.cpuprofile`, `.building-profile.log`,
`.building-planning-profile.log`, `.building-cap8-profile.log`, and
`.building-cap64-profile.log`. The CPU profile can be loaded into DevTools.
CPU samples above were filtered to generation/callback stacks to exclude
module loading and most harness work; GC samples without those stacks are
not attributed to individual stages.

The benchmark assertions passed for expected floor counts and interior
load/unload. NullEngine does not measure GPU uploads, shader compilation,
rendering, network latency, or actual browser frame pacing. The 60 FPS values
are projections from simulated frame counts, not measured wall time. The
real-map benchmark fetches live provider data before its timed generation.
