# Rendering performance investigation — 2026-09-05

## Changes retained

- **Shared vegetation-shadow state:** one scene observer resolves the sun, camera,
  shadow texture and transform. All materials share the depth/texel vectors.
  Babylon 7.54.3 retains those vector/matrix references, so unchanged sources do
  not need per-material setter calls. State changes, new materials and returning
  from a shadow-map render still rebind the required values. The nine-tap shadow
  shader, shadow darkness, map resolution and filtering are unchanged.
- **Cloud-shadow zero-contribution paths:** skip texture sampling when lighting is
  exactly zero, and skip empty cloud slots. Branches depend only on uniforms, not
  fragment position; active-cloud sampling and edge fading are unchanged.
- **One cloud selection per frame:** apply wind drift and camera/sun changes
  together, avoiding the previous duplicate candidate traversal and sort. The
  standalone `setDrift` API still updates immediately.

## CPU experiment

`yarn node --import ./tests/register-typescript.mjs tests/bench-shadow-receivers.mjs`

The test reproduces the former updater beside the new implementation using
Babylon NullEngine and real ShaderMaterials. Twelve measured batches per
implementation, 1,000 updates per batch, alternating order after warmup.
Median milliseconds per steady-state update:

| Receivers | Former updater | Shared updater |
| ---: | ---: | ---: |
| 100 | 0.02538 | 0.000185 |
| 400 | 0.13180 | 0.000259 |
| 1,000 | 0.32595 | 0.000180 |

This measures CPU bookkeeping only, not complete frame time or GPU rendering.
The tiny shared-update differences are measurement noise. The structural saving
is one lookup, zero per-frame vector allocations and no steady-state per-material
setters, instead of work proportional to receiver count.

## Real-browser experiments

The isolated Chrome harness uses its own temporary browser profile and local
server; it does not connect to or change the user's browser. The GPU identified
itself as Intel Arc 140V through ANGLE/D3D11/WebGL2.

Completed 45 full-scene phases across two runs, covering:

- baseline and shadows off;
- PCSS low quality, PCF medium and PCF low;
- SSR off, SSR off with a 4x-MSAA offscreen copy pass, and SSR at one sample;
- a separate run with back-buffer antialiasing disabled (also uncapped).

The world loaded about 10.7 million active triangles at a fixed camera. Both
completed runs reported no browser errors. Baseline images were inspected.
However, baseline drift was large and completed GPU queries were sparse. In the
second run every phase failed the minimum GPU-sample gate. Neither cross-run
differences nor apparent quality-setting gains are accepted as reliable FPS
improvements. Back-buffer AA and frame limiting changed together in that second
run, so it cannot isolate either setting's effect.

**No shadow filtering, SSR or antialiasing defaults were changed.** The slower
SSR-off path in the user's capture is still not conclusively explained.

Raw artifacts:

- `C:/Users/TOBIAS~1/AppData/Local/Temp/earth-render-perf-wWoV82/`
- `C:/Users/TOBIAS~1/AppData/Local/Temp/earth-render-perf-OpovkC/`

An earlier attempt in `earth-render-perf-3FCcrS` had a missing WASM asset and an
incomplete scene. It was discarded; the harness asset configuration was fixed.

## Reproduce / verify

```text
yarn typecheck
yarn test
yarn node --import ./tests/register-typescript.mjs tests/bench-shadow-receivers.mjs
yarn node tests/drive-render-performance.mjs --pixels
yarn node tests/drive-render-performance.mjs
```

Optional harness flags: `--no-aa`, `--uncapped`. They affect only the isolated
test browser. The harness records sample sufficiency and requires at least 120
frames and 10 completed GPU queries, subject to a 30-second phase timeout.

Full-suite result after the changes: **448 passed, 2 failed, 450 total**.
The same two failures were present in the initial run (440/442):

- `renders the road/building planning result as a standalone SVG`
- `tree models and impostors receive one shared seasonal variant`

Typechecking passes. New regression coverage exercises 400 shared receivers,
zero steady-state setter calls, changing depth/matrix state, shadow toggling,
sampler suspension/restoration, disposal/rebinding, daylight/night transitions,
and equivalence of combined cloud selection to the former two-step update.

### Real-GPU correctness checks

`--pixels` compiled and rendered the previous and optimized vegetation
cloud-shadow expressions. All six cases were **pixel-identical**: clouds off,
one visible daylight cloud with three empty slots, night, drifting daylight,
empty daylight, and disposed projector. The daylight fixture had visible
shadowing (minimum channel value 199 versus 255 when disabled).

Five additional GPU readback checks passed for the shared vegetation-shadow
uniforms: initial binding, mutated shared depth vector, shadows disabled,
shadows re-enabled, and sampler suspension/restoration. These exercise the
actual ShaderMaterial bind/upload path, not only its JavaScript value store.
One-byte rounding tolerance was allowed for the expected uniform colors.

Results: `C:/Users/TOBIAS~1/AppData/Local/Temp/earth-render-perf-2qnhSM/pixels.json`.
These GPU checks used WebGL2; WebGPU was not exercised in this investigation.
