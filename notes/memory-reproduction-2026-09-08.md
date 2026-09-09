# Spawn and movement memory reproduction

Run in PowerShell:

```powershell
$env:EARTH_MEMORY_REPRO='1'
yarn node tests/drive-render-corruption.mjs
```

The isolated Chrome fixture uses normal capture quality, WebGL, Oslo
(59.905, 10.735), 17x17 terrain and 3x3 detail. It waits for 60 ready samples
before moving continuously on an arc across tiles. Samples are approximately
one second apart, with additional browser and screenshot time. It writes
memory.json, logs.json and screenshots under the printed temporary directory.
No forced garbage collection is used. This reproduces movement through camera
positions, not keyboard input. It does not reproduce every user's graphics API,
location, hardware, or persisted settings.

## Observed failure

Baseline artifact directory:
`C:/Users/Tobias/AppData/Local/Temp/earth-render-corruption-RmKK3q`

- 132 samples over 164.849 seconds before the last responsive sample.
- 117 terrain tiles and 18 detailed tiles despite a nine-detail-tile setting.
- Peak JS heap 2.752 GiB; peak backing storage 1.047 GiB. These are separate
  CDP measurements, not an OS process-memory total.
- Last recorded frame 7,825; Runtime.evaluate then timed out after 45 seconds.
- The harness terminated its Chrome process on timeout. A subsequent browser
  OOM crash was not observed; the freeze and preceding memory growth were.

The distance-only scheduler favored new nearby detail over expired detail's
replacement far layers. Demotion depends on those layers completing, allowing
full detail to accumulate while moving.

## Scheduler replay

Expired demotion work now precedes distance ordering. Removed redundant requests
for demoted native terrain which streamTile did not rebuild.

Replay artifact directory:
`C:/Users/Tobias/AppData/Local/Temp/earth-render-corruption-LdnfZ2`

- 240 samples over 303.068 seconds; 227 ready iterations; frame 12,215.
- Maximum 12 detailed tiles; old detail released throughout movement.
- Passed the original freeze location without becoming unresponsive.
- Peak JS heap remained 3.166 GiB; peak backing storage 1.027 GiB.
- NOT a clean pass: twelve GL_INVALID_VALUE glGetProgramiv program-object
  warnings caused the driver to fail its final error check. These appeared
  during the replay and were absent from the shorter frozen baseline.

Typecheck, production build and 14 existing transition/streaming tests passed.
The scheduler change addresses the demonstrated detail backlog, but high
allocation peaks and the WebGL disposal errors remain unresolved. Do not
interpret this replay as proof that all out-of-memory crashes are fixed.

## Allocation and staging fixes

Allocation sampling (`EARTH_PROFILE=1`) identified building merge arrays and
vegetation bounding-info position objects as major allocations. Building merge
inputs now use typed buffers, and render-only vegetation bounds skip Babylon's
optional per-vertex Vector3 array.

More importantly, lazy interior callbacks were running for disabled building
chunks while they were staged at the origin. They could load interiors using
the wrong proximity, only to discard them after the tile moved to its final
offset. Disabled exteriors now skip residency work. A regression test verifies
that staging creates no interior, then enables loading at the committed offset.
Single-building merges explicitly enable their child mesh while inheriting the
parent tile's staging state. Unused surface materials are disposed immediately;
a repeated build/dispose test verifies they do not accumulate in the scene.

The coarse-terrain downgrade request is restored and implemented in streamTile,
so demoted native meshes actually rebuild at the coarse resolution.

Extended replay with allocation/staging fixes, before the coarse downgrade:
`C:/Users/Tobias/AppData/Local/Temp/earth-render-corruption-16zHQV`

- 300 samples, 393.235 seconds, 287 ready iterations, frame 15,697.
- Zero browser/WebGL errors, zero interiors under disabled tiles, no freeze.
- Peak JS heap 2.525 GiB; peak backing storage 1.840 GiB. Typed buffers shift
  memory out of the JS heap, so these figures do not establish a proportional
  decrease in total process memory.
- No forced GC or reduced capture quality. This replay retained the initial
  camera pitch; the driver now faces forward when movement starts.

The full suite reported four unrelated failures (regional vegetation variants,
tall-plant variants, seasonal variants, and the road/building SVG test), after
correcting the coarse-terrain test regression. Targeted geometry, building
staging/disposal, LOD, and terrain-control tests pass, as do typecheck and build.

Final replay including the coarse downgrade and forward camera:
`C:/Users/Tobias/AppData/Local/Temp/earth-render-corruption-DnoJ4z`

- 210 samples, 288.652 seconds, 198 ready iterations, frame 10,455; exit 0.
- Zero browser/WebGL errors, zero interiors under disabled tiles, no freeze.
- Peak JS heap 2.626 GiB, ending at 1.156 GiB; peak backing storage 1.789 GiB.
- Default streaming dimensions and full capture quality, without forced GC.
- The scripted movement crosses buildings; screenshots can show close walls.
  This is a streaming stress replay, not a complete tree-placement visual test.

Both extended replays progressed beyond the original frozen frame. Allocation
bursts remain substantial; these results verify this reproduction, not freedom
from every possible out-of-memory condition on all hardware.
