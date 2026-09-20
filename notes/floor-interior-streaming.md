# Floor Interior Streaming

Interiors now stream by floor elevation. The current floor is prioritized,
adjacent floors are prefetched, and floors beyond a two-story retention margin
can unload. Each floor publishes its walls, slab, ceiling, stairs and doors
atomically and opens its own entry gate. Furniture runs afterward as a separate,
lower-priority job. Unloaded floors keep opaque windows and closed gates.

The cooperative queue still targets 2 ms per rendered frame. Its emergency
step cap is now 256 instead of 8, allowing cheap steps to use the time budget.
Exterior work yields for at most two frame opportunities at a time, and only
for nearby structural work at the camera's elevation, not furniture.

## Measurements

Synthetic 60 x 40 metre, eight-floor apartment fixture, September 20, 2026:

- NullEngine, three measured runs: first usable floor in a median 29 simulated
  frames and 65 ms of callback CPU time. At 60 FPS, 29 frames is 0.48 seconds.
- Headless Chrome, one rendered run per viewport: ground floor ready in 248 ms
  at 997 x 731; upstairs floor ready in 244 ms at 390 x 844. Resident floors
  were [0, 1] and [4, 5, 6], respectively. Furniture was incomplete when entry
  first opened. Both canvas pixel checks, screenshots and disposal checks passed.
- The earlier all-or-nothing baseline required roughly 2,500 simulated frames
  to expose a fully furnished eight-floor building. The new milestone is usable
  floor structure, deliberately excluding furniture and distant floors.

These are synthetic results, not live-map load guarantees. Exterior planning,
network loading, shader compilation and real-world rendering load can still
affect observed latency. The time budget cannot preempt an individual mesh
operation or a garbage collection pause.

## Reproduction

```powershell
yarn node --import ./tests/register-typescript.mjs scripts/benchmark-building-loading.mjs --case=apartments-60x40-8floors --samples=3
yarn node tests/drive-render-performance.mjs --floor-streaming
```

The browser driver prints the temporary artifact directory containing
`desktop.png`, `mobile.png`, and `pixels.json`.
