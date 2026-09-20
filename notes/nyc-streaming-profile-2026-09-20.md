# NYC Streaming Investigation

The road worker stalls on application tile `17/38598/49289`. The shared worker
then holds up the next queued tile, and its 60-second watchdog rejects both.

## Reproduction

The browser connection did not expose the user's running tab. The full-scene
test therefore uses the application's New York preset (40.70562745934957,
-74.01329094009722), model range 50 m, full detail 1, and far terrain 33.
These settings are provisional, not a recovered copy of the user's settings.
The existing performance harness also fixes seed 1161908820, September 5 at
14:00, and wind speed 0. Both browser runs use these same values and fresh
isolated Chrome profiles.

```powershell
yarn test:loading '--fixture=lat=40.70562745934957&lon=-74.01329094009722&terrain-size=33&detail-size=1&vegetation-distance=50' --seconds=1200
yarn benchmark:nyc-roads
yarn node --import ./tests/register-typescript.mjs --test tests/planar-subtraction.test.mjs tests/nyc-road-planning.test.mjs
```

`--fixture` accepts the application's scene query settings, including location,
detail diameter, terrain diameter, model range, clouds, roofs, and wind speed.
The harness prints its artifact directory. `loading.json` records settings,
location, elapsed time, coverage samples, stage timings, and browser errors.
`loading.png` captures the final scene. `loading-worker-inputs.json` retains the
last four dispatched road inputs for investigating a stall without retaining
every tile's projected geometry in memory.

Completion requires every tile in the circular streaming horizon to have its
required detailed or far scenery, the current scenery revision, no active tile
builds or fades, and three seconds of stable completion. A timeout or browser
error fails the test. This is exterior streaming completion; distant interiors
are deliberately loaded only when approached by the application.

## Cause And Fix

Convex subtraction used two inclusive half-plane tolerance bands. Very small
polygons could be kept on both sides of every cut, multiplying fragments. The
exact NYC projection matters: rounding mesh depth from 24.99999999643677 to
25 hides the regression.

For the captured browser input, 3,069 input triangles became 133,853 accepted partitions.
The CPU profile remained in road merging and the worker could not complete.
Complementary, zero-tolerance half-plane classification within subtraction
reduces that to 3,810 partitions and 531 final road polygons. Other half-plane
callers retain their existing tolerance. The complete captured tile, including
building sites, finished in approximately 128 ms after the fix.

The committed fixture contains the 17 nonempty road inputs from OpenFreeMap's
OpenStreetMap data, with exact projection values preserved. The isolated road
benchmark measured 99 ms cold and 58-64 ms warm after the fix. All three new
regressions fail with the original geometry implementation and pass after it.

The next iteration shares the land-cover sampling grid used by relief strength
and sand coverage. Previously both passes called the geographic classifier at
every identical grid/halo location. The combined pass halves those calls and
retains separate, unchanged blurs. A comparison against the original source at
33x33 and 129x129 raster sizes found bit-identical elevations, shading relief,
sand coverage, relief reference elevations, and elevation ranges. All 15 terrain
detail tests pass, including a new check against duplicate classification.

## Validation

Type checking passes. The full suite reports 886 passes, 11 failures, and one
skip. All 11 failures were reproduced with the original geometry implementation;
they occur in building-planner, osm-layer-staging, performance-controls,
procedural-regional-models, and road-building-plan-image tests.

The full browser baseline stalled at 395 of 920 terrain tiles, with the same
`17/38598/49289` road task active. It did not finish within the five-minute
measurement window. The corrected full-scene measurement is recorded separately
in the local loading artifacts.

With only the road fix, the browser completed all 920 terrain/scenery tiles in
518.8 seconds (8 minutes 39 seconds), without browser errors. The largest remaining
stages were far trees (277.6 ms per far tile including waits), procedural relief
(234.7 ms per terrain tile), and nearby detailed map features (15.3 seconds per
detailed tile). These stage timings overlap and must not be added together.

The final run with shared land-cover sampling completed all 920 tiles in
471.3 seconds (7 minutes 51 seconds), with zero browser errors, active builds,
or unfinished fades. This is 47.5 seconds / 9.2% faster than the road fix alone.
Average procedural relief fell from 234.7 to 129.9 ms per tile (44.7%). All
terrain was present at 308.1 seconds; the remaining time populated far scenery.
Far trees and nearby detailed buildings remain substantial costs.

| Version | Full Scene Result |
| --- | --- |
| Original | Stalled at 395/920 terrain tiles; incomplete after five minutes |
| Complementary polygon subtraction | 920/920 complete in 518.8 s |
| Plus shared land-cover classification | 920/920 complete in 471.3 s |

Local raw reports: `artifacts/tile-timing/nyc-before.json`,
`artifacts/tile-timing/nyc-road-fix.json`, and
`artifacts/tile-timing/nyc-final.json`. The final screenshot is
`artifacts/tile-timing/nyc-final.png`. These are individual cold-profile browser
runs, not statistical confidence bounds; network, GPU, and other machine load
can affect repeated results. The deterministic worker regression and bitwise
terrain comparison independently verify the underlying fixes.
