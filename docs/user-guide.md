# User Guide

[Back to Earth](../README.md)

## Controls

- `Click`: Capture the pointer and look with the mouse
- `Escape`: Release the pointer and open settings
- `W` / `A` / `S` / `D`: Move
- `Q` / `E`: Fly down or up
- `G`: Switch between fly and walker modes
- `Space`: Jump in walker mode
- `Mouse wheel`: Change fly speed
- `V`: Cycle vegetation rendering modes
- `F`: Open or close the door you are looking at within 3 meters
- `Shift+F`: Toggle expanded performance diagnostics
- `R`: Download a render report

Walker mode uses a 1.8 m player height, terrain collision, and gravity.

## Places to Try

| Place | Latitude | Longitude |
| --- | ---: | ---: |
| Gaustatoppen, Norway | 59.853732 | 8.649698 |
| Lower Manhattan, USA | 40.705627 | -74.013291 |
| Edsåsdalen, Sweden | 63.317407 | 13.074744 |
| Coastal Bangladesh | 22.046490 | 90.678418 |

## Graphics and Persistence

Press Escape and open Graphics to choose antialiasing: MSAA 4x (default), FXAA,
TAA (experimental), or Off. Changes apply immediately and are saved locally.
The `aa=msaa`, `aa=fxaa`, `aa=taa`, and `aa=off` query parameters override the saved choice.
Babylon 7's basic TAA resets history during camera movement and can leave trails
on animated water and vegetation; it does not provide motion reprojection.
Devices without TAA support fall back to MSAA and disable the TAA menu option.

By default, the game runs without a backend and saves your position, orientation,
and movement mode in localStorage, restoring them on your next visit.
Use `?persistence=local` to explicitly select this mode.

To use the game server instead, open `?persistence=server` and start the backend:

```bash
yarn game:dev
```

In server mode, player state is persisted in `data/earth.sqlite` by the backend.
The browser connects to `ws://localhost:3001/game`; `?game-backend=wss://...` selects
a custom server and enables server mode unless `persistence=local` is explicit.
Local and server player saves are separate; changing modes does not migrate them.
Scene and clock preferences continue to use browser storage in either mode.

## Scene Settings

Click the world once to capture the pointer; looking around then follows mouse
movement without holding a button in either movement mode. Press Escape to
release the pointer and open the settings menu. It can resize both streaming
windows, adjust cloud density at runtime, set the date and time of day, and load a new
world location from latitude and longitude. Grass density remains fixed at 1.
Numeric scene settings are remembered in local storage. The same settings can
be initialized with `?detail-size=2`, `?terrain-size=33`, and
`?cloud-density=0.5`; explicit URL values override remembered values for that
page load.

`?render-scale=0.75` renders at 75% of the canvas resolution (values are clamped
from 0.25 through 1), and
`?vegetation=impostors` avoids the more expensive nearby models. These options
can be combined, for example:

`?render-scale=0.75&vegetation=impostors&performance-debug`

WebGL remains the default renderer. Use `?renderer=webgpu` to try Babylon's
WebGPU engine; unsupported devices or initialization failures automatically
fall back to WebGL. Combine it with `?performance-debug` and press `R` to
download comparable renderer and frame-time diagnostics.

The WebGPU trial starts with regular depth and without screen-space
reflections. Use `?renderer=webgpu&reverse-depth=force` or
`?renderer=webgpu&reflections=force` to isolate those features after validating
the base renderer.

See [rendering and world generation](rendering.md) for vegetation detail, wind,
clouds, clock settings, and procedural generation options.
