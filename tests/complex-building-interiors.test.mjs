import assert from "node:assert/strict";
import test from "node:test";
import { FreeCamera, Mesh, NullEngine, Ray, Scene, TransformNode, Vector3, VertexBuffer } from "@babylonjs/core";
import { planBuilding } from "../src/buildings/BuildingPlanner.ts";
import { mergeOverlappingBuildings } from "../src/buildings/CompositeBuildings.ts";
import { lonLatToScene } from "../src/world/Geo.ts";
import { ProceduralBuildingRenderer } from "../src/procedural/ProceduralBuildingRenderer.ts";
import { advanceInteriorFrame, drainInteriorBuilds } from "./interior-streaming-helpers.mjs";

const rectangle = (x, z, width, depth) => ({ outer: [[x,z],[x+width,z],[x+width,z+depth],[x,z+depth],[x,z]], holes: [] });
const source = (id, polygon, top, bottom = 0) => ({ id, polygon, properties: {
  render_height: top, render_min_height: bottom, building: "apartments",
} });
const terrain = { elevations: new Float32Array([10,10,10,10]), minElevation: 10, maxElevation: 10,
  width: 2, height: 2, bounds: { lonWest: 0, lonEast: 1, latSouth: 0, latNorth: 1 } };
const courtyard = rectangle(0.1,0.1,0.8,0.8);
courtyard.holes = [rectangle(0.35,0.35,0.3,0.3).outer];
const fixtures = {
  courtyard: [source("courtyard", courtyard, 12.4)],
  stepped: [source("podium", rectangle(0.1,0.1,0.8,0.8),6.2), source("tower", rectangle(0.3,0.3,0.4,0.4),12.4)],
  towers: [source("podium", rectangle(0.1,0.1,0.8,0.8),6.2),
    source("left", rectangle(0.15,0.3,0.25,0.4),12.4), source("right", rectangle(0.6,0.3,0.25,0.4),12.4)],
  overhang: [source("base",rectangle(0.3,0.3,0.4,0.4),6.2), source("upper",rectangle(0.1,0.1,0.8,0.8),12.4,6.2)],
  steppedCourtyard: [source("courtyard", courtyard,6.2),source("wing",rectangle(0.1,0.1,0.2,0.8),12.4)],
};

function setup(parts, scale = 1) {
  const engine = new NullEngine(), scene = new Scene(engine);
  const options = { meshWidth: 100/scale, meshDepth: 100/scale, metersPerUnit: scale, renderWholeBuildingFootprints: true };
  const plan = planBuilding(mergeOverlappingBuildings(parts)[0]);
  // Live tile batches include the composite itself in the neighboring footprints.
  // Its smaller height bands must not mistake that outer footprint for a party wall.
  options.neighboringBuildingFootprints = [plan.footprint];
  const mesh = ProceduralBuildingRenderer.createDetailed(scene,plan,terrain,options);
  const point = (lon,lat,y) => {
    const p = lonLatToScene(lon,lat,terrain.bounds,options.meshWidth,options.meshDepth);
    return new Vector3(p.x,y/scale,p.z);
  };
  return { engine, scene, mesh, point, options };
}
function hits(meshes, origin, direction, length) {
  return meshes.map((mesh) => {
    const inverse = mesh.computeWorldMatrix(true).clone().invert();
    return mesh.intersects(Ray.Transform(new Ray(origin,direction,length), inverse));
  }).filter((hit) => hit.hit);
}

for (const [name, parts] of Object.entries({
  ordinary: [source("ordinary",rectangle(0.1,0.1,0.8,0.8),12.4)],
  courtyard: fixtures.courtyard,
  towers: fixtures.towers,
})) {
  test(`${name} interior batches stay in building coordinates under a moved tile`, () => {
    const { engine,scene,mesh } = setup(parts,10);
    try {
      const pending = mesh.metadata.pendingInterior;
      const reference = new Mesh("referenceInterior",scene);
      for (const _ of pending.build(reference)) { /* Build at the origin for comparison. */ }
      const tile = new TransformNode("translatedTile",scene);
      tile.position.set(100,7,-200);
      tile.rotation.y = 0.37;
      tile.scaling.setAll(1.3);
      const moved = new Mesh("movedInterior",scene);
      moved.parent = tile;
      let step = 0;
      for (const _ of pending.build(moved)) {
        // Simulate a tile relocation while incremental geometry is still staged.
        if (++step === 20) tile.position.addInPlace(new Vector3(30,2,40));
      }
      const verticesInBuilding = (root) => {
        const inverse = root.computeWorldMatrix(true).clone().invert();
        return root.getChildMeshes().flatMap((child) => {
          const world = child.computeWorldMatrix(true);
          const vertices = child.getVerticesData(VertexBuffer.PositionKind);
          const points = [];
          for (let i = 0; i < vertices.length; i += 3) {
            const worldPoint = Vector3.TransformCoordinates(Vector3.FromArray(vertices,i),world);
            points.push(Vector3.TransformCoordinates(worldPoint,inverse));
          }
          return points;
        });
      };
      const expected = verticesInBuilding(reference), actual = verticesInBuilding(moved);
      assert.equal(actual.length,expected.length);
      for (let i = 0; i < actual.length; i++) {
        assert.ok(actual[i].equalsWithEpsilon(expected[i],0.0001),
          `vertex ${i} moved relative to its building: ${actual[i]} versus ${expected[i]}`);
      }
    } finally { scene.dispose(); engine.dispose(); }
  });
}

for (const [name, parts] of Object.entries(fixtures)) for (const scale of [1,10]) {
  test(`${name} has real entrances, connected floors and streamed interiors at scale ${scale}`, () => {
    const { engine,scene,mesh,point } = setup(parts,scale);
    try {
      assert.equal(mesh.metadata.enterable,true);
      assert.ok(mesh.metadata.pendingInterior);
      assert.equal(mesh.metadata.plannedInterior, true);
      assert.ok(mesh.metadata.interiorRoomCount > mesh.metadata.interiorFloorCount,
        "complex floors must contain planned rooms, not one open room per floor");
      assert.ok(mesh.metadata.windowCount > 0);
      assert.equal(mesh.metadata.interiorFloorCount,4);
      assert.ok(mesh.metadata.stairFlightCount >= (name === "towers" ? 5 : 3));
      const connections = mesh.metadata.stairFlightCenters;
      const pending = mesh.metadata.pendingInterior;
      // Scan the lowest outer facade below window sills. At least one gap must
      // pass fully through the wall; a solid shell behind a drawn door fails this.
      const baseMin = name === "overhang" ? 0.3 : 0.1;
      const baseMax = name === "overhang" ? 0.7 : 0.9;
      let entrances = 0;
      for (let t = baseMin + 0.02; t < baseMax - 0.02; t += 0.002) {
        for (const [a,b] of [
          [point(t,baseMin-0.01,10.8),point(t,baseMin+0.01,10.8)],
          [point(t,baseMax+0.01,10.8),point(t,baseMax-0.01,10.8)],
          [point(baseMin-0.01,t,10.8),point(baseMin+0.01,t,10.8)],
          [point(baseMax+0.01,t,10.8),point(baseMax-0.01,t,10.8)],
        ]) {
          const direction = b.subtract(a);
          if (!hits([mesh],a,direction.normalizeToNew(),direction.length()).length) entrances++;
        }
      }
      assert.ok(entrances > 0,"ground facade must have an unobstructed doorway");
      const root = new Mesh("interior",scene);
      for (const _ of pending.build(root)) { /* Drain the actual incremental generator. */ }
      const children = root.getChildMeshes();
      assert.ok(children.length);
      assert.ok(children.every((child) => child.checkCollisions));
      let partitionHits = 0;
      for (let t = baseMin + 0.03; t < baseMax - 0.03; t += 0.03) {
        const a = point(baseMin + 0.015, t, 12.6);
        const b = point(baseMax - 0.015, t, 12.6);
        const direction = b.subtract(a);
        partitionHits += hits(children, a, direction.normalizeToNew(), direction.length()).length;
      }
      assert.ok(partitionHits > 0, "streamed interiors must contain physical room partitions");
      for (const center of connections) {
        assert.equal(hits(children,new Vector3(center.x,center.y-0.04/scale,center.z),
          new Vector3(0,1,0),0.3/scale).length,0,"stairs must pierce the upper floor slab");
        assert.ok(hits(children,new Vector3(center.x,center.y-0.3/scale,center.z),
          new Vector3(0,-1,0),3.1/scale).length,"a stair tread must exist under its opening");
      }
      if (name.toLowerCase().includes("courtyard")) {
        assert.equal(hits([mesh,...children],point(0.5,0.5,30),new Vector3(0,-1,0),30/scale).length,0,
          "courtyard stays open through roofs, slabs, stairs and furniture");
      }
      if (name === "towers") {
        assert.equal(hits(children,point(0.5,0.5,22),new Vector3(0,-1,0),5/scale).length,0,
          "no upper floor bridges the gap between towers");
      }
      root.dispose(false,true);
      assert.equal(scene.getMeshByName("buildingInteriors"),null);
    } finally { scene.dispose(); engine.dispose(); }
  });
}

test("complex gates preserve courtyard and tower voids, then open atomically and clean up", (t) => {
  t.mock.method(performance,"now", (() => { let time = 0; return () => time += 1000; })());
  for (const parts of [fixtures.courtyard,fixtures.towers]) {
    const { engine,scene,mesh,point } = setup(parts);
    try {
      const tile = new TransformNode("tile",scene);
      const exterior = ProceduralBuildingRenderer.merge([mesh],"buildings",tile);
      const camera = new FreeCamera("camera",point(0.5,0.5,18),scene);
      scene.activeCamera = camera;
      camera.getViewMatrix(true);
      const original = camera.position.clone();
      scene.onBeforeCameraRenderObservable.notifyObservers(camera);
      assert.ok(camera.position.equalsWithEpsilon(original),"pending gates must not eject cameras from voids");
      camera.position.copyFrom(point(0.08,0.5,12));
      camera.getViewMatrix(true);
      advanceInteriorFrame(scene);
      assert.equal(exterior.metadata.loadingInteriorCount,1);
      assert.ok(scene.meshes.filter((m) => m.metadata?.buildingInteriorGate).every((m) => m.isEnabled()));
      // The mocked clock permits one work step per frame; denser apartments
      // need more simulated frames to furnish the complete complex.
      drainInteriorBuilds(scene, undefined, 40000);
      assert.equal(exterior.metadata.loadedInteriorCount,1);
      assert.equal(exterior.metadata.interiorsLoaded,true);
      assert.ok(scene.meshes.filter((m) => m.metadata?.buildingInteriorGate).every((m) => !m.isEnabled()));
      camera.position.set(10000,12,10000);
      camera.getViewMatrix(true);
      advanceInteriorFrame(scene);
      assert.equal(exterior.metadata.loadedInteriorCount,0);
      assert.equal(scene.getMeshByName("buildingInteriors"),null);
      assert.ok(scene.meshes.filter((m) => m.metadata?.buildingInteriorGate).every((m) => m.isEnabled()));
      tile.dispose(false,true);
      assert.equal(scene.meshes.length,0);
      assert.equal(scene.onBeforeCameraRenderObservable.hasObservers(),false);
    } finally { scene.dispose(); engine.dispose(); }
  }
});
