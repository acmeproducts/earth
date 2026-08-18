# Babylon.js Earth

A 3D Earth visualization built with Babylon.js, TypeScript, and Webpack.

![Babylon.js](https://img.shields.io/badge/Babylon.js-7.0-blue)
![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue)
![Webpack](https://img.shields.io/badge/Webpack-5.89-blue)

## Features

- 🌍 Interactive 3D Earth with atmosphere effect
- 🌙 Orbiting moon with animation
- ✨ Dynamic starfield background
- 🎥 Auto-rotating camera with manual control
- 📦 Production-ready Webpack build
- 🚀 GitHub Actions CI/CD with GitHub Pages deployment

## Getting Started

### Prerequisites

- Node.js 18+ (recommended: 20+)
- pnpm (`npm install -g pnpm`)

### Installation

```bash
# Clone the repository
git clone <your-repo-url>
cd earth

# Install dependencies
pnpm install
```

### Development

Start the development server with hot reload:

```bash
pnpm dev
```

The app will open at [http://localhost:3000](http://localhost:3000)

### Production Build

Create an optimized production build:

```bash
npm run build
```

The output will be in the `dist/` directory.

### Tree Impostor Experiment

Open `http://localhost:3000/?tree-impostor` to run the tree-only capture tool.
The controls configure the number of samples along each cube-face edge and the
resolution of each capture. The default produces 500 captures: five faces,
each with a 10 by 10 grid of 256 by 256 pixel frames.

The source family contains deterministic procedural birch, pine, and spruce trees. Birch uses
tapered branches with runtime-generated bark and textured leaf cards; pine and spruce use distinct
procedural conifer silhouettes. Forest placements mix all three species in the scene.

`treeDistributionAt(longitude, latitude)` in `src/TreeDistribution.ts` supplies the next-stage
geographic species mix. It returns a broad biome, coarse tree-cover potential, and normalized ratios
for eleven common visual tree groups. Exact forest presence should continue to come from ESA
WorldCover; the coordinate-only distribution is an offline approximation, not a botanical survey.
Every group now has its own deterministic procedural source. Tree placement samples the geographic
ratios from each tile's longitude/latitude coordinates first, then captures impostors only for the
species that were actually encountered in that tile.
After capture, that source mesh is disabled and the scene renders only a
camera-facing impostor. Its shader selects the dominant cube face and
bilinearly blends the four nearest frames. `Export ZIP` writes the five face
atlas PNGs and a JSON manifest; captured alpha is strictly 0 or 255 and RGB is
black wherever alpha is zero.

The Earth view generates a tree plus grass, white/yellow flower, and bush clumps procedurally at startup
and thin-instances them across vegetated ESA WorldCover classes. Trees use the
five-face impostor pipeline. Grass, flowers, and bushes are rotationally symmetric, so
they capture only one side and the top. Their side atlases use the optional
upper-hemisphere mode, spending every vertical row on level-to-overhead views
because these low vegetation types are not normally seen from below. Tree captures
retain the full below-to-above range and use 4 horizontal
by 4 vertical samples per face, spending the freed atlas budget on a wind
dimension instead. Each
tree frame keeps a 192 px height and derives its narrower width from the
generated tree's bounding box. `tree-impostor-x-samples`,
`tree-impostor-y-samples`, and `tree-impostor-resolution` query parameters can
override those defaults for quality testing, up to a maximum resolution of 256
px. Grass uses a 5 by 5 grid at
128 px by default. `grass-impostor-x-samples`,
`grass-impostor-y-samples`, and `grass-impostor-resolution` query parameters
can override those values for quality testing.

Bushes are generated from procedural branches and dense curved shoots, captured
into their own directional atlases, and scattered in noise-shaped clusters most
densely through WorldCover shrubland with lighter placement elsewhere.

Trees sway in a looping wind cycle. `src/Wind.ts` owns the cycle and the GLSL
that displaces a vertex within it, and both the atlas capture pass and the live
model material run that same code: an impostor frame is therefore exactly what
the model would have looked like at that moment, so the two agree through the
LOD transition. Every vertex moves on the loop's fundamental frequency and
differs only in phase, which is what makes a small number of captured moments
sufficient — harmonics or per-vertex flutter would alias into noise between
frames.

Each tree face captures 4 moments of the loop alongside its 4 by 4 directions,
laid out along the atlas's tile-column axis, and the shader dithers between
consecutive moments the same way it already dithers between neighboring
directions. Gusts travel across the world, so an instance's position sets its
phase and the forest reads as one moving air mass. The sway direction is the
model's own local X, which per-instance yaw scatters: that is what keeps the
directional atlas valid, and it also avoids a uniformly combed forest.

Grass, flowers, and bushes lean a different way, because their atlases exploit
rotational symmetry and a folded atlas cannot hold a directional pose. They use
a pure shear instead: displacement grows linearly with height above the base, so
the roots stay planted and the tips lean furthest. A shear needs no captured
moments at all. Real geometry adds the gradient to its vertices, while an
impostor subtracts the same gradient from the point it samples inside its own
frame, which leans the captured image by exactly as much. Nothing is baked, so
that lean is free to follow one world direction and carry a second harmonic —
the forest's captured sway can do neither.

Displacing the sample point *after* it has been projected is what anchors the
lean to the subject rather than to its proxy box, which for grass is over four
times the clump's own height. Side on, image height is capture height, so the
frame shears progressively. From overhead the projection plane is level and the
whole frame shifts by the lean at mid-height, which is as close as a flat lookup
gets to a silhouette smeared through every height. The technique needs slack
around the subject inside its frame; the square captures of low vegetation have
it, and a tightly fitted capture like the trees' would clip.

`?wind=0` removes all vegetation motion and collapses the capture's time axis
back to a single moment; values up to 3 scale it. `tree-impostor-time-samples`
overrides the number of captured moments (1 to 8).

Shadows do not follow any of this by default. Nothing is missing from the
shaders — the depth pass reuses each vegetation vertex shader, so the model
displacement, the impostor's captured moment and its lean are all already in the
shadow silhouette. The only reason shadows sit still is that the map renders once
and caches until the LOD packing or the sun changes. `?shadow-refresh=N`
re-renders it every N frames instead, at the cost of re-drawing every caster that
often — and the caster list includes every grass clump, which is by far the most
expensive part of it.

Impostor capture is model-agnostic. `src/Impostor.ts` owns sampling validation,
URL overrides, per-scene reuse, source disposal, optional bounds fitting, and
atlas generation. To add another procedural model, define an
`ImpostorDefinition` with its geometry factory, capture dimensions, sampling
limits, faces, and symmetry, then create its provider with
`createImpostorAssetProvider`. The tree, bush, and grass files are examples;
they contain only model-specific geometry and descriptor values.

The production view renders grass and bushes exclusively as dense impostor
clumps. Trees can switch between impostors, automatic distance LOD, and original
geometry. Auto mode uses a
dithered 6 m transition around the configurable model range (50 m by default)
to blend real models into impostors. Press `V` to cycle the tree mode.
The top-right counter reports live FPS and active triangles; use
`?vegetation=models` to force tree models or
`?vegetation-distance=20` to change the initial Auto range.

The landscape extends beyond the detailed player area with a lower-detail terrain
ring. Its compact 3 by 3 level-13 footprint keeps the horizon focused while the
fixed vegetation budget produces roughly four times the former tree density. The
ring uses a coarser WorldCover tint and tree impostors to keep the expanded horizon
inexpensive while blending into the local terrain. Its OSM vector data is fetched
at zoom 14 so the vista retains per-building heights even though its elevation
data is coarser.

The world uses an application-owned Web Mercator grid at fixed level 14. A tile
is identified by the app's level/x/y coordinates and receives a stable seed from
the world seed and that identity. Elevation, WorldCover, and OpenStreetMap tile
coordinates are source implementation details used only to populate the app
tile's geographic bounds. Because this is Web Mercator, ground dimensions vary
with latitude (a detailed tile is about 1.2 km wide around Oslo). Use `?seed=123`
to select another deterministic world seed.

The detailed terrain defaults to a 1 by 1 application-tile grid, which cuts terrain
samples and the detailed vegetation area to roughly one quarter of the former
2 by 2 default. Values from 1 through 4 remain available through
`?inner-size=2`. `?render-scale=0.75` renders at 75% of the canvas
resolution (values are clamped from 0.25 through 1), and
`?vegetation=impostors` avoids the more expensive nearby models. These options
can be combined, for example:

`?inner-size=1&render-scale=0.75&vegetation=impostors&performance-debug`

Add `performance-debug` (or `perf`) to expand the top-right counter with frame
and render time, draw calls, active meshes, render scale, and inner-grid size.
Press `F` to toggle the expanded counter at runtime.


## Project Structure

```
earth/
├── .github/
│   └── workflows/
│       └── build-deploy.yml    # GitHub Actions CI/CD
├── src/
│   ├── index.html              # HTML template
│   ├── index.ts                # Entry point
│   └── Game.ts                 # Main Babylon.js game class
├── public/                     # Static assets (copied to dist)
├── package.json
├── tsconfig.json               # TypeScript configuration
├── webpack.config.js           # Webpack configuration
└── README.md
```

## Controls

- **G**: Switch between fly and walker modes
- **W/A/S/D**: Move forward, left, backward, and right
- **Q/E**: Fly down and up (fly mode only)
- **Mouse + Drag**: Look around
- **Mouse Wheel**: Increase or decrease fly speed (fly mode only)

Walker mode uses a 1.8 m player height, terrain collision, and gravity.

## Deployment

This project includes automated deployment to GitHub Pages:

1. Push to `main` or `master` branch
2. GitHub Actions will automatically build and deploy
3. Your site will be available at `https://<username>.github.io/<repo-name>`

### Manual Deployment

To deploy manually to any static hosting:

```bash
pnpm build
# Upload the contents of dist/ to your hosting provider
```

## Scripts

| Script | Description |
|--------|-------------|
| `pnpm dev` | Start development server |
| `pnpm build` | Create production build |
| `pnpm clean` | Remove dist folder |

## Customization

### Adding Textures

The normal terrain appearance is isolated in `src/TerrainMaterial.ts`. Its
procedural detail texture is tinted with softly blended ESA WorldCover surface
colors so vegetated ground visually supports the grass, bush, and tree layers.
Place texture images in the `public/` folder and assign them in that factory:

```typescript
import { Texture } from '@babylonjs/core';

material.diffuseTexture = new Texture('/terrain-texture.jpg', scene);
```

The exact WorldCover classification debug view is toggled with `L`;
OpenTopoMap is toggled with `P`.

### Modifying the Scene

Edit `src/Game.ts` to customize:
- Lighting and colors
- Camera settings
- 3D objects and materials
- Animations

## Tech Stack

- **[Babylon.js](https://www.babylonjs.com/)** - 3D rendering engine
- **[TypeScript](https://www.typescriptlang.org/)** - Type-safe JavaScript
- **[Webpack](https://webpack.js.org/)** - Module bundler
- **[GitHub Actions](https://github.com/features/actions)** - CI/CD

## License

MIT
