# Building loading diagnostics

## Incremental interior loading — 2026-09-13

Interior loading now uses one scene-wide queue with a **2 ms cooperative CPU
budget and at most eight steps per rendered frame**. Room furniture planning,
individual furniture meshes, wall segments, slabs, stair flights, buffer
compaction, small merges, and activation yield between work units. Merges target
at most 4,096 vertices (a single indivisible source mesh can exceed that target).
The final interior stays in those batches; there is no whole-building merge.
Exterior layout plans are reused instead of being calculated again on approach.

Geometry builds under a disabled root. Once construction finishes, batches are
enabled incrementally so first draws are spread out too. Windows reveal the
interior only after activation finishes. Moving away or disposing/disabling the
tile cancels work and releases staged meshes and materials. Returning can retry
a cancelled build. Failed builds log an error and are not repeatedly retried.

Filter for `[Building stream]`: one start message, progress at most once every
two seconds for the active build, and a completion/cancellation/failure message.
Completion includes elapsed wall time, active CPU time, frames, step count,
maximum slice, worst individual step, and aggregate CPU time by stage. There
are no per-frame or per-furniture-item messages. The existing
`globalThis.buildingTimingEnabled` switch controls these logs too.

Run a paced CPU check with:

```text
yarn benchmark:buildings --paced --case=apartments-60x40-8floors --samples=1
```

One warm-up plus one measured run of the large apartment interior produced:

| Measurement | Result |
| --- | ---: |
| Simulated frames to load | 1,571 |
| Loading slice, 95th percentile | 4.24 ms |
| Worst loading slice | 48.00 ms |
| Active callback CPU time across all frames | 3,630.70 ms |
| Interior unload | 4.77 ms |

At 60 FPS that frame count corresponds to about 26 seconds. The paced headless
run actually took about 49 seconds because its timer waits were longer than
16 ms. It does not measure browser/GPU performance. The budget cannot preempt
an individual Babylon call or garbage collection; the largest remaining
outlier was a merge/materials step. This trades more total work and draw calls
for smaller work slices. Exterior generation is still synchronous and remains
a separate source of stalls; the historical baseline below is not a controlled
before/after comparison of the complete renderer. Raw paced output is in
`.building-paced-benchmark.log` locally.

Validation: 48 targeted checks passed, including shared frame budgets, log
throttling, error handling, cancellation/reload, tile disposal, geometry,
furniture, collision/headroom, and interior use. TypeScript checks also passed.

## Original instrumentation and baseline

Building diagnostics are enabled by default. Filter the browser console for
`[Building timing]`. Each operation logs its building/tile/chunk identity, total,
slowest stage, status, and stage durations in milliseconds. Geometry logs include
floor, window, mesh-part, furniture-item, and merged vertex counts where relevant.
Failures log the stage reached and rethrow the original error.

The coverage includes source decoding/use inference, overlapping footprint
merging, semantic planning, terrain sampling, shared facades, building/apartment
layouts, stair planning, layout capture, roofs, facade geometry, floor slabs,
interior walls and furniture, buffer compaction, merging, source disposal,
materials/submeshes, shadow casters, proximity activation, and interior disposal.
Layer logs separate building work from frame yields. Existing `[Streaming timing]`
logs include tile fetches and now split boundaries, lamps, matrix updates, frame
waits, activation, and shadow refresh.

These are wall-clock CPU-side measurements. Nested operations are inclusive:
do not sum a parent total with its child traces. Merge/upload stages measure the
JavaScript call, not GPU completion or later shader compilation. Logs are batched
into one string per operation, but console output still adds overhead. Disable
building diagnostics for comparison with `globalThis.buildingTimingEnabled = false`
in the browser console; set it to `true` to restore them.

## Local CPU benchmark — 2026-09-12

Run `yarn benchmark:buildings`. The script uses Babylon 7.54.3 NullEngine, flat
synthetic terrain, deterministic rectangular footprints and seed 12345. Each
fixture runs once as warm-up followed by three measured repetitions in fresh
scenes. Floor counts are asserted. It invokes the actual proximity callback and
asserts that an interior loads and unloads after the camera moves away. Polling
waits are excluded from the measurements. Instrumentation is enabled.

| Fixture | Exterior median | Exterior merge/materials median | Proximity interior load median (max) | Unload median |
| --- | ---: | ---: | ---: | ---: |
| House, 12 × 10 m, 2 floors | 76.98 ms | 9.01 ms | 14.49 ms (41.35 ms) | 0.56 ms |
| Apartments, 30 × 16 m, 4 floors | 109.77 ms | 6.57 ms | 202.27 ms (374.82 ms) | 0.60 ms |
| Apartments, 60 × 40 m, 8 floors | 374.74 ms | 11.03 ms | 2000.28 ms (2284.72 ms) | 0.93 ms |
| Warehouse, 60 × 40 m, 1 floor | 35.13 ms | 3.50 ms | 8.47 ms (9.26 ms) | 0.44 ms |

The large apartment interior contains 2,703 mesh parts and 749,520 merged
vertices. Across its three measured repetitions:

- Furniture geometry across eight floors: 981.50–1392.19 ms.
- Interior wall geometry: 186.33–253.34 ms.
- Furniture planning: 112.83–145.15 ms.
- Final interior merge: 269.53–328.02 ms.
- Buffer compaction: 80.85–97.57 ms.

The scene-wide one-interior-per-frame limit still permits a single large interior
to block for about two seconds. The strongest measured bottleneck is synchronous
furniture geometry creation, with merging and wall generation also substantial.
Exterior creation can independently exceed a frame budget. Incremental interior
generation and smaller merge batches are the next candidates to investigate.

No connected browser was available during this run. These results reproduce CPU
stalls in the production renderer functions, but do not establish the exact
building or GPU/browser contribution in the reported gameplay freeze. The sample
size is small and timings depend on machine load and JIT/GC behavior. Raw output
from this run is in the local ignored `.building-benchmark.log` file.

Validation after measurement: TypeScript with unused-local/parameter checks
passed. All 33 targeted tests passed (19.64 seconds total), covering diagnostics,
renderer geometry and lazy interiors, streaming merge budgets, interior use, and
map-layer disposal. `git diff --check` passed.
