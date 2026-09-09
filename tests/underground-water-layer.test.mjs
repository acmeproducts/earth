import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { readFileSync } from "node:fs";
import { NullEngine, Scene } from "@babylonjs/core";

const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "lerc") return {
      url: "data:text/javascript,export function decode(){throw new Error('Unexpected raster decode')} export function load(){throw new Error('Unexpected raster load')}",
      shortCircuit: true,
    };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith("/WorldCover.ts")) return {
      format: "module", shortCircuit: true,
      source: stripTypeScriptTypes(readFileSync(new URL(url), "utf8"), { mode: "transform" }),
    };
    return nextLoad(url, context);
  },
});
const { OpenStreetMap } = await import("../src/OpenStreetMap.ts");
hook.deregister();

test("underground Oslo river tags produce no surface ribbon or lake terrain source", async () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const coordinates = [[10.751, 59.911], [10.759, 59.919]];
  const properties = { name: "Akerselva", class: "river", intermittent: 0, brunnel: "tunnel" };
  const tile = { x: 8681, y: 4766, zoom: 14, data: { layers: {
    waterway: { length: 1, feature: () => ({ id: 644951252, properties,
      toGeoJSON: () => ({ geometry: { type: "LineString", coordinates } }),
    }) },
    water: { length: 1, feature: () => ({ id: 1, properties,
      toGeoJSON: () => ({ geometry: { type: "Polygon", coordinates: [[
        coordinates[0], [10.759, 59.911], coordinates[1], [10.751, 59.919], coordinates[0],
      ]] } }),
    }) },
  } } };
  const terrain = {
    bounds: { lonWest: 10.75, lonEast: 10.76, latSouth: 59.91, latNorth: 59.92 },
    width: 3, height: 3, groundWidthMeters: 560, groundHeightMeters: 1110,
    elevations: new Float32Array(9).fill(10), minElevation: 10, maxElevation: 10,
  };
  try {
    const layer = await OpenStreetMap.createLayer(scene, [tile], terrain,
      { meshWidth: 560, meshDepth: 1110, metersPerUnit: 1 });
    assert.equal(layer.counts.water, 0);
    assert.deepEqual(layer.lakePolygons, []);
    assert.deepEqual(layer.meshes, []);
    assert.equal(scene.meshes.length, 0);
  } finally {
    scene.dispose();
    engine.dispose();
  }
});
