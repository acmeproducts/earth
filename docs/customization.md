# Customization

[Back to Earth](../README.md)

## Adding Textures

The normal terrain appearance is isolated in `src/terrain/TerrainMaterial.ts`. Its
procedural detail texture is tinted with softly blended ESA WorldCover surface
colors so vegetated ground visually supports the grass, bush, and tree layers.
Place texture images under `assets/`, resolve them through Webpack, and assign
them in that factory:

```typescript
import { Texture } from '@babylonjs/core';

const terrainTextureUrl = new URL(
  '../assets/terrain-texture.jpg',
  import.meta.url,
).toString();
material.diffuseTexture = new Texture(terrainTextureUrl, scene);
```

Detailed tiles refine ESA WorldCover 2021 with globally available OpenStreetMap
land-cover and land-use polygons. OSM also supplies building-part visibility,
road class, path and service type, surface, tunnels, and permanent waterways;
those attributes drive building filtering, road widths and materials, vegetation
placement, and narrow water surfaces without relying on regional data sources.
Street lamps are placed deterministically from the road plan, only within 50 metres
of a building footprint (including mapped lamps). The client does not
query the public Overpass API while streaming terrain detail.

## Interior building layouts

`BuildingLayoutPlanner.ts` contains the renderer-independent interface for
dividing a local, meter-based building footprint into apartment, hallway, and
stair polygons. Footprints up to 120 m² remain one apartment shell. Larger
footprints receive common circulation and are divided into apartment shells no
larger than 120 m². The same algorithm is currently used for every building
type. The stair core sits beside one continuous hallway and is placed
deterministically so matching floors retain the same vertical core. A supplied
exterior door creates an entrance-lobby branch to the hallway; the stair moves
beside that lobby instead of occupying the doorway. Apartment entrance doors
are generated on each shared apartment–hallway boundary.

Building interiors use explicit building tags first, including provider subclasses.
Stepped composites and courtyard buildings also receive enterable facades and
incrementally loaded interiors. These use furnished open floors that follow each
height band's footprint, preserving courtyard voids, terraces, and overhangs.
Stairs connect overlapping sections without filling the gaps between towers.
Their entry gates follow the same shapes and open when the whole interior is ready.

For unclassified buildings, `BuildingUseInference.ts` uses recognized POIs inside
the footprint, then enclosing land-use polygons. Courtyards are excluded and
conflicting categories remain unresolved. Residential buildings with a mapped
shop, office, or clinic inside receive that use on the ground floor and retain
apartments above. Predictions are recorded on `BuildingPlan.interiorUseSource`;
`groundFloorUse` records mixed use. Context comes from the same provider tile's
`poi` and `landuse` layers, so missing data still leaves the residential fallback.

`ApartmentLayoutPlanner.ts` recursively bisects an apartment into equally sized
rooms with orthogonal walls. It stops before either resulting room would be
smaller than 10 m² and tries the other axis when a proposed wall intersects a
supplied door or window segment.

```typescript
import { planBuildingLayout } from "./src/buildings/BuildingLayoutPlanner";
import { renderFloorPlanSvg } from "./src/buildings/FloorPlan";

const layout = planBuildingLayout({
  buildingType: "apartment-building",
  buildingPolygon: {
    outer: [
      { x: 0, y: 0 }, { x: 20, y: 0 },
      { x: 20, y: 12 }, { x: 0, y: 12 },
    ],
  },
});

const svgImage = renderFloorPlanSvg(layout, { width: 900, height: 600 });
```

`renderFloorPlanSvg` depends only on the generic `PolygonLayout` contract, so
the apartment-room planner and other future planners can use the same image
pipeline. Callers can display the returned SVG directly or save it as an
`.svg` file for design review. Optional `door` and `window` opening segments are
included in planner output and drawn over the plan outline.

Run `yarn layouts:examples` to regenerate rectangular, tapered, and angled
example plans in `data/layout-examples`.

## Road and building plans

`RoadAndBuildingPlanImage.ts` turns the renderer-independent output of
`planRoadsAndBuildings` into a standalone, north-up SVG. The image uses the
plan's complete tile bounds, so sparse and empty plans retain the same scale.
It draws the exact partitioned road surfaces and shoulders, building footprints
and holes, building plots, street lamps, road markings, layers, and structures
with machine-readable SVG data attributes for future planning diagnostics.

The plan also places street lamps (mapped lamp nodes plus deterministic
road-side infill just beyond the planned road bed) and designates one convex
plot per building. Plots grow outward from the building, then are cut flush
against nearby road beds, the tile bounds, and the bisector toward each
neighboring plot, so adjacent plots share their dividing boundary exactly —
the attachment line for future hedgerows and fences.

```typescript
import { renderRoadAndBuildingPlanSvg } from "./src/roads/RoadAndBuildingPlanImage";

const svgImage = renderRoadAndBuildingPlanSvg(plan, {
  width: 1000,
  height: 700,
  title: "Road and building planning",
  showLabels: true,
});
```

Run `yarn site-plan:example` to write an example to
`data/road-building-plan-examples/site-plan.svg`.

## Modifying the Scene

Edit `src/app/Game.ts` to customize:
- Lighting and colors
- Camera settings
- 3D objects and materials
- Animations
