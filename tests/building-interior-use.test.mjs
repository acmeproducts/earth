import assert from "node:assert/strict";
import test from "node:test";
import { planBuilding } from "../src/BuildingPlanner.ts";
import { FreeCamera, NullEngine, Scene, TransformNode, Vector3, VertexBuffer } from "@babylonjs/core";
import { ProceduralBuildingRenderer } from "../src/procedural/ProceduralBuildingRenderer.ts";

test("building interiors distinguish available retail and office tags without inventing business detail", () => {
  const polygon = { outer: [[0, 0], [1, 0], [1, 1], [0, 0]], holes: [] };
  for (const [properties, expected] of [
    [{ class: "retail" }, "shop"], [{ building: "supermarket" }, "shop"],
    [{ class: "yes", shop: "clothes" }, "shop"], [{ office: "company" }, "office"],
    [{ "building:use": "office" }, "office"], [{ class: "commercial" }, "office"],
    [{ class: "apartments" }, "residential"], [{ class: "hotel" }, "hotel"],
    [{ tourism: "hotel" }, "hotel"], [{ amenity: "school" }, "education"],
    [{ class: "education" }, "education"], [{ class: "university" }, "education"],
    [{ healthcare: "clinic" }, "medical"], [{ amenity: "doctors" }, "medical"],
    [{ class: "medical" }, "medical"], [{ class: "warehouse" }, "warehouse"],
    [{ building: "factory" }, "industrial"], [{ class: "garages" }, "garage"],
    [{ shop: "no", office: "no" }, undefined], [{ shop: "vacant" }, undefined],
    [{ class: "yes" }, undefined],
  ]) {
    assert.equal(planBuilding({ id: "fixture", polygon, properties }).interiorUse, expected);
  }
});

test("building use tags reach the streamed interior compiler, including open floors", () => {
  const geometry = [];
  for (const buildingClass of ["retail", "office", "apartments", "hotel", "school", "clinic", "warehouse", "industrial", "garages"]) {
    const engine = new NullEngine(), scene = new Scene(engine);
    try {
      const building = planBuilding({ id: "same-building", properties: { class: buildingClass, render_height: 6.2, levels: 2 },
        polygon: { outer: [[0.35, 0.42], [0.65, 0.42], [0.65, 0.58], [0.35, 0.58], [0.35, 0.42]], holes: [] } });
      const terrain = { elevations: new Float32Array([10, 10, 10, 10]), minElevation: 10, maxElevation: 10,
        width: 2, height: 2, worldTile: { level: 14, x: 0, y: 0 }, generationSeed: 1,
        groundWidthMeters: 100, groundHeightMeters: 100, bounds: { lonWest: 0, lonEast: 1, latSouth: 0, latNorth: 1 } };
      const detailed = ProceduralBuildingRenderer.createDetailed(scene, building, terrain, { meshWidth: 100, meshDepth: 100, metersPerUnit: 1 });
      assert.equal(detailed.metadata.plannedInterior, !["warehouse", "industrial", "garages"].includes(buildingClass));
      ProceduralBuildingRenderer.merge([detailed], "buildings", new TransformNode("root", scene));
      scene.activeCamera = new FreeCamera("camera", new Vector3(0, 15, 0), scene);
      scene.onAfterRenderObservable.notifyObservers(scene);
      const interior = scene.getMeshByName("buildingInteriors");
      assert.ok(interior);
      const positions = interior.getVerticesData(VertexBuffer.PositionKind);
      assert.ok(positions.every(Number.isFinite));
      geometry.push(positions);
    } finally { scene.dispose(); engine.dispose(); }
  }
  assert.notDeepEqual(geometry[0], geometry[1]);
  assert.notDeepEqual(geometry[1], geometry[2]);
  for (let i = 3; i < geometry.length; i++) {
    assert.notDeepEqual(geometry[i], geometry[1]);
    assert.notDeepEqual(geometry[i], geometry[i - 1]);
  }
});
