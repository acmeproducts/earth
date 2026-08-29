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
  "../src/procedural/ProceduralBuildingRenderer.ts"
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

function horizontalRoofCovers(mesh, x, z) {
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
  const indices = mesh.getIndices();
  const maximumY = meshBounds(mesh).maximumY;
  const cross = (ax, az, bx, bz, px, pz) => (px - bx) * (az - bz) - (ax - bx) * (pz - bz);
  for (let index = 0; index < indices.length; index += 3) {
    const vertices = [indices[index], indices[index + 1], indices[index + 2]].map((vertex) => ({
      x: positions[vertex * 3] + mesh.position.x,
      y: positions[vertex * 3 + 1] + mesh.position.y,
      z: positions[vertex * 3 + 2] + mesh.position.z,
    }));
    if (!vertices.every((vertex) => Math.abs(vertex.y - maximumY) < 1e-5)) continue;
    const signs = vertices.map((vertex, vertexIndex) => {
      const next = vertices[(vertexIndex + 1) % 3];
      return cross(vertex.x, vertex.z, next.x, next.z, x, z);
    });
    if (signs.every((sign) => sign >= -1e-6) || signs.every((sign) => sign <= 1e-6)) return true;
  }
  return false;
}

function windowDimensions(mesh) {
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
  const colors = mesh.getVerticesData(VertexBuffer.ColorKind);
  const windowVertices = [];
  for (let vertex = 0; vertex < colors.length / 4; vertex++) {
    if (Math.abs(colors[vertex * 4 + 3] - 0.16) < 1e-6) windowVertices.push(vertex);
  }
  assert.equal(windowVertices.length % 4, 0);
  const dimensions = [];
  for (let index = 0; index < windowVertices.length; index += 4) {
    const first = windowVertices[index] * 3;
    const second = windowVertices[index + 1] * 3;
    const third = windowVertices[index + 2] * 3;
    dimensions.push({
      width: Math.hypot(
        positions[second] - positions[first],
        positions[second + 2] - positions[first + 2],
      ),
      height: positions[third + 1] - positions[second + 1],
    });
  }
  return dimensions;
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

test("courtyard buildings keep interior rings instead of roofing over nested buildings", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const courtyardFootprint = {
    outer: footprint.outer,
    holes: [[
      [0.45, 0.46], [0.55, 0.46], [0.55, 0.54], [0.45, 0.54], [0.45, 0.46],
    ]],
  };
  const building = planBuilding({
    id: "building/14/courtyard/0",
    polygon: courtyardFootprint,
    properties: { render_height: 12 },
  });
  const detailed = ProceduralBuildingRenderer.createDetailed(scene, building, terrain, options);
  const far = ProceduralBuildingRenderer.createFar(scene, building, terrain, options);
  assert.ok(detailed && far);
  assert.equal(detailed.metadata.complexFootprint, true);
  assert.equal(detailed.metadata.courtyardCount, 1);
  assert.equal(detailed.metadata.enterable, false);
  assert.equal(horizontalRoofCovers(detailed, 0, 0), false);
  assert.equal(horizontalRoofCovers(far, 0, 0), false);

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

test("skillion roof metadata renders as a symmetric roof", () => {
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
  const shadowCaster = scene.getMeshByName("buildingShadows");
  assert.ok(shadowCaster);
  assert.equal(shadowCaster.geometry, merged.geometry);
  assert.equal(shadowCaster.metadata.shadowOnly, true);
  assert.equal(shadowCaster.isVisible, false);
  assert.ok(
    shadowCaster.subMeshes.reduce((sum, subMesh) => sum + subMesh.indexCount, 0) <
      merged.getTotalIndices(),
  );

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

test("building class controls the first interior profile", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const warehouse = ProceduralBuildingRenderer.createDetailed(
    scene,
    plan(323, { render_height: 12, levels: 4, class: "warehouse" }),
    terrain,
    options,
  );
  const school = ProceduralBuildingRenderer.createDetailed(
    scene,
    plan(324, { render_height: 12, levels: 4, class: "school" }),
    terrain,
    options,
  );
  assert.ok(warehouse && school);
  assert.equal(warehouse.metadata.buildingClass, "warehouse");
  assert.equal(warehouse.metadata.interiorFloorCount, 1);
  assert.equal(warehouse.metadata.stairFlightCount, 0);
  assert.equal(school.metadata.buildingClass, "education");
  assert.equal(school.metadata.interiorFloorCount, 4);
  assert.equal(school.metadata.stairFlightCount, 3);

  scene.dispose();
  engine.dispose();
});

test("house heights without mapped levels do not round up to a second floor", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const detailed = ProceduralBuildingRenderer.createDetailed(
    scene,
    plan(322, { render_height: 5.9, roof_shape: "flat" }),
    terrain,
    options,
  );
  assert.ok(detailed);
  assert.equal(detailed.metadata.interiorFloorCount, 1);
  assert.equal(detailed.metadata.stairFlightCount, 0);

  scene.dispose();
  engine.dispose();
});

test("facade windows keep one coherent size per building", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const detailed = ProceduralBuildingRenderer.createDetailed(
    scene,
    plan(654, { render_height: 12, levels: 4 }),
    terrain,
    options,
  );
  assert.ok(detailed);
  const dimensions = windowDimensions(detailed);
  assert.ok(dimensions.length > 8);
  for (const dimension of dimensions) {
    assert.ok(Math.abs(dimension.width - dimensions[0].width) < 1e-5);
    assert.ok(Math.abs(dimension.height - dimensions[0].height) < 1e-5);
  }

  const neighbor = ProceduralBuildingRenderer.createDetailed(
    scene,
    plan(656, { render_height: 12, levels: 4 }),
    terrain,
    options,
  );
  assert.ok(neighbor);
  const neighborDimensions = windowDimensions(neighbor);
  assert.ok(neighborDimensions.length > 8);
  assert.notDeepEqual(
    [dimensions[0].width.toFixed(3), dimensions[0].height.toFixed(3)],
    [neighborDimensions[0].width.toFixed(3), neighborDimensions[0].height.toFixed(3)],
  );

  scene.dispose();
  engine.dispose();
});

test("short mapped buildings do not grow an extra facade level", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const detailed = ProceduralBuildingRenderer.createDetailed(
    scene,
    plan(655, { render_height: 1.8, levels: 2, roof_shape: "flat" }),
    terrain,
    options,
  );
  assert.ok(detailed);
  assert.equal(detailed.metadata.interiorFloorCount, 1);
  assert.equal(detailed.metadata.windowCount, 0);
  assert.equal(detailed.metadata.stairFlightCount, 0);

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
