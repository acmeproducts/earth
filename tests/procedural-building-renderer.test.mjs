import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import {
  FreeCamera,
  Material,
  MultiMaterial,
  NullEngine,
  PBRMaterial,
  Scene,
  TransformNode,
  Vector3,
  VertexBuffer,
} from "@babylonjs/core";
import { planBuilding } from "../src/BuildingPlanner.ts";

register("./ts-extension-resolver.mjs", import.meta.url);
const { ProceduralBuildingRenderer } = await import(
  "../src/ProceduralBuildingRenderer.ts"
);

const footprint = {
  outer: [[0.35, 0.42], [0.65, 0.42], [0.65, 0.58], [0.35, 0.58], [0.35, 0.42]],
  holes: [],
};
const terrain = {
  elevations: new Float32Array([10, 10, 10, 10]),
  minElevation: 10,
  maxElevation: 10,
  width: 2,
  height: 2,
  worldTile: { level: 14, x: 0, y: 0 },
  generationSeed: 1,
  groundWidthMeters: 100,
  groundHeightMeters: 100,
  bounds: { lonWest: 0, lonEast: 1, latSouth: 0, latNorth: 1 },
};
const options = { meshWidth: 100, meshDepth: 100, metersPerUnit: 1 };

function plan(id, properties = {}) {
  return planBuilding({ id: `building/14/${id}/0`, polygon: footprint, properties });
}

function meshBounds(mesh) {
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
  const xs = [], ys = [], zs = [];
  for (let index = 0; index < positions.length; index += 3) {
    xs.push(positions[index] + mesh.position.x);
    ys.push(positions[index + 1] + mesh.position.y);
    zs.push(positions[index + 2] + mesh.position.z);
  }
  return {
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
    depth: Math.max(...zs) - Math.min(...zs),
    maximumY: Math.max(...ys),
  };
}

test("inferred roofs rise above the mapped massing without clipping its cap", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const building = plan(42, { render_height: 12, roof_shape: "gabled" });
  const detailed = ProceduralBuildingRenderer.createDetailed(scene, building, terrain, options);
  const far = ProceduralBuildingRenderer.createFar(scene, building, terrain, options);
  assert.ok(detailed && far);

  const detailedBounds = meshBounds(detailed);
  const farBounds = meshBounds(far);
  assert.ok(detailedBounds.maximumY >= farBounds.maximumY + 1.99);
  assert.ok(detailedBounds.width >= farBounds.width + 0.6);
  assert.ok(detailedBounds.depth >= farBounds.depth + 0.6);

  scene.dispose();
  engine.dispose();
});

test("stable seeds vary roof construction, overhang, and color", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const vertexCounts = new Set();
  const widths = new Set();
  const colors = new Set();

  for (let id = 1; id <= 24; id++) {
    const mesh = ProceduralBuildingRenderer.createDetailed(
      scene,
      plan(id, { render_height: 12 }),
      terrain,
      options,
    );
    assert.ok(mesh);
    vertexCounts.add(mesh.getTotalVertices());
    widths.add(meshBounds(mesh).width.toFixed(2));
    colors.add(
      Array.from(mesh.getVerticesData(VertexBuffer.ColorKind))
        .slice(0, 3)
        .map((value) => value.toFixed(3))
        .join(","),
    );
    mesh.dispose(false, true);
  }

  assert.ok(vertexCounts.size >= 3);
  assert.ok(widths.size >= 3);
  assert.ok(colors.size >= 6);
  scene.dispose();
  engine.dispose();
});

test("skillion roofs contain no collapsed triangles", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const mesh = ProceduralBuildingRenderer.createDetailed(
    scene,
    plan(99, { render_height: 12, roof_shape: "skillion" }),
    terrain,
    options,
  );
  assert.ok(mesh);
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
  const indices = mesh.getIndices();

  for (let triangle = 0; triangle < indices.length; triangle += 3) {
    const a = indices[triangle] * 3;
    const b = indices[triangle + 1] * 3;
    const c = indices[triangle + 2] * 3;
    const ux = positions[b] - positions[a];
    const uy = positions[b + 1] - positions[a + 1];
    const uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a];
    const vy = positions[c + 1] - positions[a + 1];
    const vz = positions[c + 2] - positions[a + 2];
    const doubledArea = Math.hypot(
      uy * vz - uz * vy,
      uz * vx - ux * vz,
      ux * vy - uy * vx,
    );
    assert.ok(doubledArea > 1e-7);
  }

  scene.dispose();
  engine.dispose();
});

test("detailed buildings defer interiors until the camera is very close", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const detailed = ProceduralBuildingRenderer.createDetailed(
    scene,
    plan(123, { render_height: 9.3, levels: 3 }),
    terrain,
    options,
  );
  const far = ProceduralBuildingRenderer.createFar(
    scene,
    plan(123, { render_height: 9.3, levels: 3 }),
    terrain,
    options,
  );
  assert.ok(detailed && far);
  assert.equal(detailed.metadata.enterable, true);
  assert.equal(detailed.metadata.interiorsLoaded, false);
  assert.equal(detailed.metadata.interiorFloorCount, 3);
  assert.equal(detailed.metadata.stairFlightCount, 2);
  assert.notEqual(detailed.metadata.stairEdgeIndex, detailed.metadata.entranceEdgeIndex);
  assert.equal(detailed.metadata.stairFlightCenters.length, 2);
  assert.notDeepEqual(
    detailed.metadata.stairFlightCenters[0],
    detailed.metadata.stairFlightCenters[1],
  );
  assert.ok(Math.hypot(
    detailed.metadata.stairFlightCenters[1].x - detailed.metadata.stairFlightCenters[0].x,
    detailed.metadata.stairFlightCenters[1].z - detailed.metadata.stairFlightCenters[0].z,
  ) > 4.5);
  assert.ok(detailed.metadata.windowCount >= 8);
  const colors = detailed.getVerticesData(VertexBuffer.ColorKind);
  assert.ok(colors.some((_, index) => index % 4 === 3 && colors[index] < 0.5));
  assert.ok(detailed.getTotalVertices() > far.getTotalVertices() * 4);

  const merged = ProceduralBuildingRenderer.merge(
    [detailed],
    "buildings",
    new TransformNode("root", scene),
  );
  assert.equal(scene.getMeshByName("buildingInteriors"), null);
  assert.ok(merged.material instanceof MultiMaterial);
  assert.equal(merged.subMeshes.length, 2);
  assert.equal(merged.material.subMaterials[0].transparencyMode, Material.MATERIAL_OPAQUE);
  assert.equal(merged.material.subMaterials[1].transparencyMode, Material.MATERIAL_ALPHABLEND);

  scene.activeCamera = new FreeCamera("camera", new Vector3(0, 15, 0), scene);
  merged.onBeforeRenderObservable.notifyObservers(merged);
  assert.ok(scene.getMeshByName("buildingInteriors"));
  assert.equal(merged.metadata.loadedInteriorCount, 1);
  assert.equal(merged.metadata.pendingInteriorCount, 0);

  scene.dispose();
  engine.dispose();
});

test("one-story buildings keep a single floor and no stairs", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const detailed = ProceduralBuildingRenderer.createDetailed(
    scene,
    plan(321, { render_height: 3.1, levels: 1 }),
    terrain,
    options,
  );
  assert.ok(detailed);
  assert.equal(detailed.metadata.interiorFloorCount, 1);
  assert.equal(detailed.metadata.stairFlightCount, 0);
  assert.deepEqual(detailed.metadata.stairFlightCenters, []);

  scene.dispose();
  engine.dispose();
});

test("stable building seeds produce varied facade rhythms", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const windowCounts = new Set();

  for (let id = 700; id < 716; id++) {
    const detailed = ProceduralBuildingRenderer.createDetailed(
      scene,
      plan(id, { render_height: 12, levels: 4 }),
      terrain,
      options,
    );
    assert.ok(detailed);
    windowCounts.add(detailed.metadata.windowCount);
    detailed.dispose(false, true);
  }

  assert.ok(windowCounts.size >= 4);
  scene.dispose();
  engine.dispose();
});

test("tall buildings use deterministic reflective high-rise massing", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const tower = ProceduralBuildingRenderer.createDetailed(
    scene,
    plan(456, { render_height: 80, levels: 26 }),
    terrain,
    options,
  );
  const far = ProceduralBuildingRenderer.createFar(
    scene,
    plan(456, { render_height: 80, levels: 26 }),
    terrain,
    options,
  );
  assert.ok(tower && far);
  assert.equal(tower.metadata.highRise, true);
  assert.equal(tower.metadata.enterable, false);
  assert.equal(tower.getTotalVertices(), far.getTotalVertices());

  const merged = ProceduralBuildingRenderer.merge(
    [tower],
    "buildings",
    new TransformNode("root", scene),
  );
  assert.ok(merged.material instanceof MultiMaterial);
  const reflective = merged.material.subMaterials.find(
    (material) => material instanceof PBRMaterial,
  );
  assert.ok(reflective);
  assert.equal(reflective.transparencyMode, Material.MATERIAL_OPAQUE);
  assert.equal(reflective.alpha, 1);
  const colors = merged.getVerticesData(VertexBuffer.ColorKind);
  assert.ok(colors.every((value, index) => index % 4 !== 3 || value === 1));
  assert.equal(merged.metadata.pendingInteriorCount, undefined);

  scene.dispose();
  engine.dispose();
});
