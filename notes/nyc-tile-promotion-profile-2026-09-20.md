# NYC far-to-detail promotion

## Reproduction

Run `yarn test:promotion --max-ms=20000`. Chrome is launched with an isolated
profile; the user's browser and saved settings are untouched. Artifacts go to
the temporary directory printed at startup: `promotion.json`,
`promotion.cpuprofile`, `promotion.png`, and `promotion-overview.png`.

The fixture uses the same provisional NYC location as the preceding loading
test: latitude 40.70562745934957, longitude -74.01329094009722, model range 50 m,
detail window 1, seed 1161908820, manual date 2026-09-05/time 14. It uses a
5-tile far window to isolate promotion from the 920-tile horizon load. These
are reproducible fixture settings, not a recovered user browser save.
`--fixture=<query>` can override the location and window settings.

The test settles the initial scene, verifies that tile 17/38590/49284 has full
far scenery and no native/detail terrain, then moves the camera two tiles east
to its center. Timing starts before movement. The normal scheduler, frame
budget, worker planning, vegetation, and fades remain enabled. Completion
requires detailed map geometry enabled, no active detail builds, and no fades.
Lazy interiors retain their normal proximity-based behavior; the test does not
force all floors into memory. The overhead screenshot is taken after timing.

## Iterations

| Version | Promotion | Map features/commit |
| --- | ---: | ---: |
| Baseline | 46.096 s | 28.587 s |
| Skip disabled active-mesh candidates | 44.080 s | 26.146 s |
| Building collision batches | 40.874 s | 24.542 s |
| Freeze collision transforms and register static map meshes | 37.295 s | 22.154 s |
| Repeat static-transform build, fresh browser profile | 36.866 s | 21.985 s |
| Batch facade shells before GPU upload | 24.915 s | See raw profile |
| Overlap vegetation and map builds, shared frame boundary | 16.652 s | Overlapping phases |
| Repeat overlapping build, fresh browser profile | 16.664 s | Overlapping phases |

Final result: 63.9% shorter than the original baseline (2.77x throughput),
and 54.8% shorter than the previous 36.866 s result. Both final runs are
16.7 s to one decimal place; the repeat passed the 20 s guard.

The first optimization pass was 19.1% shorter; its repeat confirmed 20.0%.
Frame interval median/p95: 15.5/24.2 ms before, 12.8/19.4 ms after.
Repeat median/p95: 12.5/19.1 ms. The final overhead screenshot was inspected
and shows the detailed building scene rendered.
After batching plus overlapping: first-run median/p95 12.4/20.3 ms, maximum
159.9 ms. Overlapping is faster to finish than batching alone, but has a higher
p95 (batching alone: 15.8 ms). Neither changes the existing work-slice limits.
Maximum frame interval was not improved: 228.6 ms before, 236.7 ms after.
All runs finished without browser errors. Counts remained 27 buildings,
6 roads, 29 lamps, 735 grass instances, 34 tall plants, and 1 sapling.

## Findings And Changes

Main-thread CPU samples showed scene evaluation and ground-height ray picking
dominating actual building generator execution. Cooperative yields amplify
that recurring frame work throughout a tile build.

- Disabled temporary geometry now exits active-mesh evaluation before Babylon
  updates its transforms and bounding volumes. Parent-disabled geometry is
  covered, and enabling it brings it back without re-registration.
- Building collision meshes share the original GPU geometry but use bounded
  1536-index collision submeshes, following the existing terrain implementation.
  Render submeshes and rendered detail are unchanged. The visible mesh remains
  pickable for interactions; collision proxies are invisible and non-pickable.
- Committed map-layer meshes use the existing static candidate cache. Animated
  doors and lazy interior children are not frozen by this registration.
  Collision transforms are frozen separately; tile translation explicitly
  refreshes them through the existing offset helper.
- Facade wall quads accumulate into 4096-vertex batches before upload, replacing
  thousands of temporary four-vertex meshes that were immediately merged again.
  Lazy wall thickness builders are retained. Two independent high-rise fixtures
  kept identical triangle/normal/color/surface-attribute hashes after canonical
  triangle ordering and five-decimal normalization, with 357/642 windows and
  6962/10380 triangles unchanged. Wall/window uploads fell from 1714/2869 to 3/4.
- Map geometry and vegetation construction now overlap. Both stage their work
  under the shared cooperative budget. Frame-boundary requests are coalesced,
  rather than resetting the budget separately for each concurrent phase.
  Both promises settle before error/cancellation cleanup, so a later map result
  cannot outlive a failed vegetation phase unowned. Phase timings now overlap
  and must not be summed as sequential elapsed time.

Remaining time includes vegetation placement/atlas acquisition and cooperative
building geometry generation; the transition is still not instantaneous.

## Verification

- `yarn typecheck`: passed.
- Collision, terrain collision, static candidate/batch, and streaming budget
  tests: 12 passed, including frozen collider tile-offset coverage.
- Building planning worker, procedural renderer, and complex interior tests:
  65 passed.
- Follow-up: those 65 passed after batching; the new high-rise upload regression
  passed; frame-budget and building streaming tests passed (15). Typecheck passed.
- CPU profiles and raw JSON: baseline `earth-render-perf-gE9uCe`, disabled
  culling `earth-render-perf-uuNAYi`, collision batches `earth-render-perf-0pIHEl`,
  final `earth-render-perf-Hy6ly2`, all under the system temporary directory.
  The first final JSON is also retained at
  `artifacts/tile-timing/promotion-final-first.json`.
- Follow-up profiles: shell batching `earth-render-perf-Pg6SZL`, overlapping
  construction `earth-render-perf-bWa1Gh`. First overlapping JSON is retained
  at `artifacts/tile-timing/promotion-overlap-first.json`; the latter temp
  directory now contains the repeat, including its inspected overview image.
