import assert from "node:assert/strict";
import test from "node:test";
import polygonClipping from "polygon-clipping";
import { NullEngine, Ray, Scene, TransformNode, Vector3 } from "@babylonjs/core";
import { planBuilding } from "../src/buildings/BuildingPlanner.ts";
import { ProceduralBuildingRenderer } from "../src/procedural/ProceduralBuildingRenderer.ts";
import { findInteraction } from "../src/app/InteractionSystem.ts";

const terrain = { elevations: new Float32Array([10, 10, 10, 10]), minElevation: 10, maxElevation: 10,
  width: 2, height: 2, bounds: { lonWest: 0, lonEast: 1, latSouth: 0, latNorth: 1 } };
const ring = [[0.3, 0.3], [0.7, 0.3], [0.7, 0.7], [0.3, 0.7], [0.3, 0.3]];

for (const courtyard of [false, true]) for (const scale of [1, 10])
for (const failures of courtyard ? [0] : [0, 1, 2]) {
  test(`${courtyard ? "courtyard" : "ordinary"} roof exit connects to walkable stairs at scale ${scale}, union failures ${failures}`, (t) => {
    const engine = new NullEngine(), scene = new Scene(engine);
    engine.getDeltaTime = () => 16;
    try {
      const plan = planBuilding({
        id: "roof-stair-test", polygon: { outer: ring,
          holes: courtyard ? [[[0.45, 0.45], [0.55, 0.45], [0.55, 0.55], [0.45, 0.55], [0.45, 0.45]]] : [] },
        properties: { building: "apartments", render_height: 12.4, levels: 4, roof_shape: "flat" },
      });
      let unionCalls = 0;
      const union = polygonClipping.union;
      if (failures) t.mock.method(polygonClipping, "union", (...args) => {
        if (++unionCalls <= failures) throw new Error("Unable to complete output ring starting at [-8.418786739780165, 0.004069848306043092].");
        return union(...args);
      });
      const building = ProceduralBuildingRenderer.createDetailed(scene, plan, terrain,
        { meshWidth: 100 / scale, meshDepth: 100 / scale, metersPerUnit: scale });
      if (failures) assert.equal(unionCalls, 2, "roof union retries once before falling back");
      const access = courtyard ? building.metadata.roofAccesses[0] : building.metadata.roofAccess;
      assert.ok(access, "a roof exit must have a planned stair connection");
      const interior = new TransformNode("interior", scene);
      for (const _ of building.metadata.pendingInterior.build(interior)) { /* Complete streamed geometry. */ }
      building.setEnabled(true);
      interior.setEnabled(true);
      scene.meshes.forEach((mesh) => mesh.computeWorldMatrix(true));
      assert.ok(building.getVerticesData("position").every(Number.isFinite));
      const door = building.getChildMeshes().find((mesh) => mesh.metadata?.buildingDoor);
      assert.ok(door);
      const roofY = door.getAbsolutePosition().y;
      const cap = scene.pickWithRay(new Ray(new Vector3(15 / scale, roofY + 1 / scale, 15 / scale),
        Vector3.Down(), 1.1 / scale), (mesh) => mesh === building);
      assert.ok(cap?.hit, "a solid roof cap remains away from the stair opening");
      const stair = access.stair;
      const point = (along, y) => new Vector3(stair.start.x + stair.direction.x * along / scale,
        y, stair.start.z + stair.direction.z * along / scale);
      const pick = (ray) => scene.pickWithRay(ray, (mesh) => mesh === building || mesh.isDescendantOf(interior));
      let previousY = -Infinity;
      for (let sample = 0; sample < 12; sample++) {
        const along = stair.runMeters * (sample + 0.5) / 12;
        const tread = pick(new Ray(point(along, roofY + 0.2 / scale), Vector3.Down(), 4 / scale));
        assert.ok(tread?.hit, "each part of the flight has a tread");
        assert.ok(tread.pickedPoint.y > previousY, "treads rise toward the roof landing without a slab blocking them");
        previousY = tread.pickedPoint.y;
        const overhead = pick(new Ray(tread.pickedPoint.add(new Vector3(0, 0.02 / scale, 0)), Vector3.Up(), 1.95 / scale));
        assert.equal(overhead?.hit, false, "roof opening gives the ascending player headroom");
      }
      const landing = pick(new Ray(point(stair.runMeters + 0.45, roofY + 0.2 / scale), Vector3.Down(), 0.4 / scale));
      assert.ok(landing?.hit);
      assert.ok(Math.abs(landing.pickedPoint.y - roofY) * scale < 1e-4, "landing and door threshold are flush");
      const origin = Vector3.TransformCoordinates(new Vector3(0.45 / scale, 1 / scale, -0.6 / scale), door.getWorldMatrix());
      const direction = Vector3.TransformNormal(Vector3.Forward(), door.getWorldMatrix()).normalize();
      const ray = new Ray(origin, direction, 1.2 / scale);
      const action = findInteraction(scene, ray);
      assert.equal(action?.label, "Open door");
      action.activate();
      for (let frame = 0; frame < 30; frame++) scene.onBeforeRenderObservable.notifyObservers(scene);
      scene.meshes.forEach((mesh) => mesh.computeWorldMatrix(true));
      assert.equal(scene.pickWithRay(ray)?.hit, false, "open exit connects the landing and roof");
    } finally {
      scene.dispose();
      engine.dispose();
    }
  });
}
