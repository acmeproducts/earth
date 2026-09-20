# Development

[Back to Earth](../README.md)

## Scripts

| Script | Description |
|--------|-------------|
| `yarn dev` | Start the Webpack development server |
| `yarn game:dev` | Start the local WebSocket/SQLite server |
| `yarn build` | Create an optimized production build |
| `yarn test` | Run the Node test suite |
| `yarn typecheck` | Type-check without emitting files |
| `yarn clean` | Remove `dist/` |

## Production Build

Create an optimized production build:

```bash
yarn build
```

The output will be in the `dist/` directory.

## Deployment

GitHub Actions builds every push and pull request to `main` or `master` and
uploads `dist/` as a workflow artifact. Successful builds on `main` also deploy
to [GitHub Pages](https://magnificus.github.io/earth/). Pull requests build without
publishing. The workflow can also be run manually from the Actions tab.

In repository Settings > Pages, select **GitHub Actions** as the build and
deployment source. Pages hosts the static app; the optional WebSocket/SQLite
game server requires separate hosting.

### Manual Deployment

To deploy manually to any static hosting:

```bash
yarn build
# Upload the contents of dist/ to your static host.
```

## Duplicate Code Check

With Python 3.12 and Node.js installed, run `corepack yarn check:duplication`.
This downloads the same `duplicateCodeChecker3.py` used by CI and checks `src`,
excluding test/spec files. Set `PYTHON` if your Python executable has another name.
Open `duplication_report.html` for the matches; the report and comparison files
are ignored by Git. The default ceiling is zero: every detected duplication fails
the check. An optional numeric argument sets a ceiling for local investigation.

All 69 original duplication groups (severity 13,120) have been removed by sharing
geometry, placement, rendering, and lifecycle helpers. CI explicitly requires zero
severity, even when an older artifact contains a higher baseline. Pull requests
use the target branch's latest successful push artifact for report comparisons
only. Pushes to `main`/`master` publish baseline artifacts; every run publishes its
HTML report.

## Project Structure

```
earth/
├── assets/                     # Source textures and README media
├── scripts/                    # Catalog and diagnostic generators
├── server/                     # Optional WebSocket/SQLite game server
├── src/                        # Scene, simulation, and rendering code
│   ├── app/                    # Game lifecycle, settings, and player controls
│   ├── buildings/              # Building and apartment layout planning
│   ├── core/                   # Shared math, geometry, time, and caches
│   ├── demos/                  # Asset previews and impostor validation
│   ├── diagnostics/            # Performance counters and streaming reports
│   ├── integration/            # Local and server-backed player state
│   ├── procedural/             # Buildings, trees, and actor distribution
│   ├── rendering/              # Renderer, antialiasing, and impostor capture
│   ├── roads/                  # Road and site planning, street lamps
│   ├── sky/                    # Sun, moon, stars, and clouds
│   ├── terrain/                # Elevation, terrain meshes, and materials
│   ├── vegetation/             # Plants, trees, rocks, placement, and wind
│   ├── water/                  # Water surfaces, coastlines, and shorelines
│   ├── world/                  # Geography, map providers, and world tiles
│   ├── index.html              # Application shell
│   └── index.ts                # Browser entry point
├── tests/                      # Node test suite and browser drivers
├── package.json
├── tsconfig.json
└── webpack.config.js
```

## Further Reading

- [Customization](customization.md): terrain materials, building layouts, and site plans.
- [Performance and Diagnostics](performance.md): reports, captures, and browser tests.
- [Rendering and World Generation](rendering.md): impostors, vegetation, weather, and streaming.
- [Investigation notes](../notes/): dated profiles and architecture notes.
