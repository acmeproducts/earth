import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const { buildingOwnerWorldTile } = await import("../src/buildings/BuildingTileOwnership.ts");
const { worldTileBounds } = await import("../src/world/WorldGrid.ts");

test("assigns a cross-boundary building to its first north-west application tile", () => {
  const tile = { level: 16, x: 34_000, y: 20_000 };
  const bounds = worldTileBounds(tile);
  const longitudeStep = (bounds.lonEast - bounds.lonWest) * 0.05;
  const latitudeStep = (bounds.latNorth - bounds.latSouth) * 0.05;
  const ring = [
    [bounds.lonEast - longitudeStep, bounds.latSouth + latitudeStep],
    [bounds.lonEast + longitudeStep, bounds.latSouth + latitudeStep],
    [bounds.lonEast + longitudeStep, bounds.latSouth - latitudeStep],
    [bounds.lonEast - longitudeStep, bounds.latSouth - latitudeStep],
  ];

  const owner = buildingOwnerWorldTile({ outer: [...ring, ring[0]], holes: [] }, 16);
  assert.deepEqual(owner, tile);
});

test("building ownership does not depend on polygon traversal order", () => {
  const tile = { level: 16, x: 34_000, y: 20_000 };
  const bounds = worldTileBounds(tile);
  const longitudeStep = (bounds.lonEast - bounds.lonWest) * 0.05;
  const latitudeStep = (bounds.latNorth - bounds.latSouth) * 0.05;
  const ring = [
    [bounds.lonEast + longitudeStep, bounds.latSouth - latitudeStep],
    [bounds.lonEast - longitudeStep, bounds.latSouth - latitudeStep],
    [bounds.lonEast - longitudeStep, bounds.latSouth + latitudeStep],
    [bounds.lonEast + longitudeStep, bounds.latSouth + latitudeStep],
  ];

  const owner = buildingOwnerWorldTile({ outer: ring, holes: [] }, 16);
  assert.deepEqual(owner, tile);
});

test("streamed OSM buildings render whole while terrain planning stays tile-clipped", () => {
  const source = readFileSync(new URL("../src/world/OpenStreetMap.ts", import.meta.url), "utf8");
  const renderer = readFileSync(
    new URL("../src/procedural/BuildingRendererCompiler.ts", import.meta.url),
    "utf8",
  );
  const planner = readFileSync(
    new URL("../src/roads/RoadAndBuildingPlanner.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /renderWholeBuildingFootprints: true/);
  assert.match(source, /buildingBelongsToWorldTile\(source\.polygon, terrain\.worldTile\)/);
  assert.match(source, /paths: source\.paths\.flatMap\(\(path\) => clipPolyline\(/);
  assert.match(planner, /const outline = clipToBounds\(withoutClosingPoint\(building\.outline\), bounds\)/);
  assert.match(renderer, /options\.renderWholeBuildingFootprints \? points : clipToBounds\(points, clipBounds\)/);
});
