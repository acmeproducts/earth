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
resolution of each capture. The default produces 600 captures: six faces,
each with a 10 by 10 grid of 500 by 500 pixel frames.

The source is a deterministic procedural broadleaf built from tapered branches
and vertex-colored leaf geometry. After capture, that source mesh is disabled and the scene renders only a
camera-facing impostor. Its shader selects the dominant cube face and
bilinearly blends the four nearest frames. `Export ZIP` writes the six face
atlas PNGs and a JSON manifest; captured alpha is strictly 0 or 255 and RGB is
black wherever alpha is zero.

The Earth view generates the same tree plus a grass clump procedurally at startup, captures
it through the same six-face impostor pipeline, and thin-instances it across
vegetated ESA WorldCover classes. Grass uses a horizontally biased 16 by 4,
80 px capture by default. `grass-impostor-x-samples`,
`grass-impostor-y-samples`, and `grass-impostor-resolution` query parameters
can override those values for quality testing.

Bushes are generated from procedural branches and dense curved shoots, captured
into their own directional atlases, and scattered most densely through
WorldCover shrubland with lighter placement in other vegetated classes.

The production view can switch trees, grass, and bushes independently between
their impostors, automatic distance LOD, and original geometry. Auto mode uses
a dithered 6 m transition around the configurable model range (10 m by default)
to blend real models into impostors. Press `V` to cycle all three modes. The top-right counter reports
live FPS and active triangles; use `?vegetation=models` to force every real
model or `?vegetation-distance=20` to change the initial Auto range.


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

- **W/A/S/D**: Fly forward, left, backward, and right
- **Q/E**: Fly down and up
- **Mouse + Drag**: Look around
- **Mouse Wheel**: Increase or decrease fly speed

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

The normal terrain appearance is isolated in `src/TerrainMaterial.ts`. Place
texture images in the `public/` folder and assign them in that factory:

```typescript
import { Texture } from '@babylonjs/core';

material.diffuseTexture = new Texture('/terrain-texture.jpg', scene);
```

WorldCover is a debug view toggled with `L`; OpenTopoMap is toggled with `P`.
Neither debug layer affects the normal terrain material.

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
