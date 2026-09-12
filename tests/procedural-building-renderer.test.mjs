import assert from "node:assert/strict";
import test from "node:test";
import {
  FreeCamera,
  Material,
  MultiMaterial,
  NullEngine,
  Ray,
  Scene,
  TransformNode,
  Vector3,
  VertexBuffer,
} from "@babylonjs/core";

const { planBuilding } = await import("../src/BuildingPlanner.ts");
const { ProceduralBuildingRenderer, stairLayoutFromPlan } = await import(
  "../src/procedural/ProceduralBuildingRenderer.ts"
);
const { BUILDING_MATERIAL_VERTEX_KIND } = await import(
  "../src/procedural/BuildingMaterial.ts"
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

test("repeated building disposal releases unused surface materials", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    // Creating geometry initializes Babylon's one scene-owned default material.
    const defaultMaterial = scene.defaultMaterial;
    for (let index = 0; index < 3; index++) {
      const root = new TransformNode("tile", scene);
      const mesh = ProceduralBuildingRenderer.createDetailed(
        scene, plan(123, { render_height: 4.7 }), terrain, options,
      );
      ProceduralBuildingRenderer.merge([mesh], "buildings", root);
      root.dispose(false, true);
      assert.deepEqual(scene.materials, [defaultMaterial]);
      assert.equal(scene.multiMaterials.length, 0);
    }
  } finally {
    scene.dispose();
    engine.dispose();
  }
});

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

function pointInPolygon(point, polygon) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const a = polygon[index];
    const b = polygon[previous];
    if ((a.y > point.y) !== (b.y > point.y) &&
        point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

test("flat composite roofs have only one upper surface across the footprint", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const building = planBuilding({
      id: "composite:flat-roof",
      polygon: {
        outer: [[0.3, 0.3], [0.6, 0.3], [0.6, 0.45], [0.45, 0.45], [0.45, 0.6], [0.3, 0.6], [0.3, 0.3]],
        holes: [],
      },
      properties: { render_height: 12, roof_shape: "flat" },
    });
    for (const metersPerUnit of [1, 10]) {
      const mesh = ProceduralBuildingRenderer.createDetailed(scene, building, terrain, {
        ...options, metersPerUnit,
        meshWidth: options.meshWidth / metersPerUnit,
        meshDepth: options.meshDepth / metersPerUnit,
      });
      assert.ok(mesh);
      const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
      const normals = mesh.getVerticesData(VertexBuffer.NormalKind);
      const indices = mesh.getIndices();
      const upperElevations = new Set();
      for (let i = 0; i < indices.length; i += 3) {
        const triangle = [indices[i], indices[i + 1], indices[i + 2]];
        if (!triangle.every((vertex) => normals[vertex * 3 + 1] > 0.99)) continue;
        // Rooftop equipment has its own small top faces; inspect the roof slabs.
        const [a, b, c] = triangle.map((vertex) => ({
          x: positions[vertex * 3] * metersPerUnit,
          z: positions[vertex * 3 + 2] * metersPerUnit,
        }));
        if (Math.abs((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x)) / 2 < 20) continue;
        const heights = triangle.map((vertex) =>
          (positions[vertex * 3 + 1] + mesh.position.y) * metersPerUnit);
        if (heights.every((height) => height > 22.01)) {
          heights.forEach((height) => upperElevations.add(height.toFixed(3)));
        }
      }
      assert.equal(upperElevations.size, 1, "a flat roof must not have a second trim cap above the walls");
      mesh.dispose(false, true);
    }
  } finally {
    scene.dispose();
    engine.dispose();
  }
});

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

test("pitched roofs seal the wall clearance and the underside of every overhang", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  for (const metersPerUnit of [1, 2]) {
    for (const id of [42, 83, 97]) {
      const scaledOptions = { ...options, metersPerUnit };
      const building = plan(id, { render_height: 12, roof_shape: "gabled" });
      const mesh = ProceduralBuildingRenderer.createDetailed(scene, building, terrain, scaledOptions);
      const far = ProceduralBuildingRenderer.createFar(scene, building, terrain, scaledOptions);
      assert.ok(mesh && far);
      mesh.computeWorldMatrix(true);
      const wallY = meshBounds(far).maximumY;
      const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
      const roofXs = [], roofZs = [];
      for (let vertex = 0; vertex < positions.length; vertex += 3) {
        if (positions[vertex + 1] + mesh.position.y < wallY + 0.199 / metersPerUnit) continue;
        roofXs.push(positions[vertex] + mesh.position.x);
        roofZs.push(positions[vertex + 2] + mesh.position.z);
      }
      const halfWidth = Math.max(...roofXs);
      const halfDepth = Math.max(...roofZs);
      for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const edgeX = x * (halfWidth - 0.01 / metersPerUnit);
        const edgeZ = z * (halfDepth - 0.01 / metersPerUnit);
        const underside = new Ray(
          new Vector3(edgeX, wallY - 0.02 / metersPerUnit, edgeZ),
          Vector3.Up(), 0.04 / metersPerUnit,
        );
        assert.ok(underside.intersectsMesh(mesh).hit, `sealed underside: seed ${id}, side ${x},${z}`);
        const edge = new Ray(
          new Vector3(edgeX + x, wallY + 0.19 / metersPerUnit, edgeZ + z),
          new Vector3(-x, 0, -z), 2,
        );
        assert.ok(edge.intersectsMesh(mesh).hit, `sealed edge: seed ${id}, side ${x},${z}`);
      }
      mesh.dispose();
      far.dispose();
    }
  }
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

  assert.ok(vertexCounts.size >= 2);
  assert.ok(widths.size >= 3);
  assert.ok(colors.size >= 6);
  scene.dispose();
  engine.dispose();
});

test("mapped building materials survive batching as procedural surface attributes", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const brick = ProceduralBuildingRenderer.createDetailed(
    scene,
    plan(81, { render_height: 12, material: "brick", roof_material: "slate" }),
    terrain,
    options,
  );
  const timber = ProceduralBuildingRenderer.createDetailed(
    scene,
    plan(82, { render_height: 12, material: "wood", roof_material: "metal" }),
    terrain,
    options,
  );
  assert.ok(brick && timber);
  const brickMaterials = new Set(brick.getVerticesData(BUILDING_MATERIAL_VERTEX_KIND));
  const timberMaterials = new Set(timber.getVerticesData(BUILDING_MATERIAL_VERTEX_KIND));
  assert.ok(brickMaterials.has(1));
  assert.ok(brickMaterials.has(7));
  assert.ok(timberMaterials.has(4));
  assert.ok(timberMaterials.has(8));

  const merged = ProceduralBuildingRenderer.merge(
    [brick, timber],
    "materialBuildings",
    new TransformNode("root", scene),
  );
  assert.ok(merged);
  assert.ok(merged.isVerticesDataPresent(BUILDING_MATERIAL_VERTEX_KIND));
  assert.ok(merged.material.subMaterials[0].CustomParts);

  scene.dispose();
  engine.dispose();
});

test("pitched roof faces expose upward normals to sky lighting", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const detailed = ProceduralBuildingRenderer.createDetailed(
    scene,
    plan(83, { render_height: 12, roof_shape: "gabled", roof_material: "tile" }),
    terrain,
    options,
  );
  assert.ok(detailed);

  const normals = detailed.getVerticesData(VertexBuffer.NormalKind);
  const materials = detailed.getVerticesData(BUILDING_MATERIAL_VERTEX_KIND);
  const pitchedNormalYs = [];
  for (let vertex = 0; vertex < detailed.getTotalVertices(); vertex++) {
    const material = materials[vertex * 2];
    const normalY = normals[vertex * 3 + 1];
    if (material >= 6 && Math.abs(normalY) > 1e-5 && Math.abs(normalY) < 1 - 1e-5) {
      pitchedNormalYs.push(normalY);
    }
  }
  assert.ok(pitchedNormalYs.length > 0);
  assert.ok(pitchedNormalYs.every((normalY) => normalY > 0));

  scene.dispose();
  engine.dispose();
});

test("hipped and pyramidal metadata use the full-length gabled roof", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const roofPositions = (roofShape) => {
    const mesh = ProceduralBuildingRenderer.createDetailed(
      scene,
      plan(97, { render_height: 12, roof_shape: roofShape }),
      terrain,
      options,
    );
    assert.ok(mesh);
    return Array.from(mesh.getVerticesData(VertexBuffer.PositionKind));
  };

  const gabled = roofPositions("gabled");
  assert.deepEqual(roofPositions("hipped"), gabled);
  assert.deepEqual(roofPositions("pyramidal"), gabled);

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

test("disabled tile staging never loads interiors at its temporary origin", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const root = new TransformNode("stagedTile", scene);
    root.setEnabled(false);
    const detailed = ProceduralBuildingRenderer.createDetailed(
      scene, plan(123, { render_height: 9.3, levels: 3 }), terrain, options,
    );
    const merged = ProceduralBuildingRenderer.merge([detailed], "buildings", root);
    const camera = new FreeCamera("camera", new Vector3(0, 15, 0), scene);
    scene.activeCamera = camera;
    scene.onAfterRenderObservable.notifyObservers(scene);
    assert.equal(merged.metadata.loadedInteriorCount, 0);
    assert.equal(scene.getMeshByName("buildingInteriors"), null);
    root.position.x = 1000;
    root.computeWorldMatrix(true);
    root.setEnabled(true);
    camera.position.x = 1000;
    camera.getViewMatrix(true);
    scene.onAfterRenderObservable.notifyObservers(scene);
    assert.equal(merged.metadata.loadedInteriorCount, 1);
  } finally {
    scene.dispose();
    engine.dispose();
  }
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
  assert.equal(detailed.metadata.plannedInterior, true);
  assert.equal(detailed.metadata.interiorFloorCount, 3);
  assert.equal(detailed.metadata.stairFlightCount, 2);
  assert.equal(detailed.metadata.stairEdgeIndex, -1);
  assert.equal(detailed.metadata.stairFlightCenters.length, 2);
  assert.notDeepEqual(
    detailed.metadata.stairFlightCenters[0],
    detailed.metadata.stairFlightCenters[1],
  );
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
  assert.equal(merged.subMeshes.length, 3);
  assert.equal(merged.material.subMaterials[0].transparencyMode, Material.MATERIAL_OPAQUE);
  assert.equal(merged.material.subMaterials[1].transparencyMode, Material.MATERIAL_ALPHABLEND);
  const windowMetal = merged.material.subMaterials[2];
  assert.equal(windowMetal.transparencyMode, Material.MATERIAL_OPAQUE);
  assert.equal(windowMetal.metallic, 0.85);
  assert.equal(windowMetal.roughness, 0.32);
  const shadowCaster = scene.getMeshByName("buildingShadows");
  assert.ok(shadowCaster);
  assert.equal(shadowCaster.geometry, merged.geometry);
  assert.equal(shadowCaster.metadata.shadowOnly, true);
  assert.equal(shadowCaster.isVisible, false);
  assert.equal(
    shadowCaster.subMeshes.reduce((sum, subMesh) => sum + subMesh.indexCount, 0),
    merged.getTotalIndices(),
  );

  scene.activeCamera = new FreeCamera("camera", new Vector3(0, 15, 0), scene);
  scene.onAfterRenderObservable.notifyObservers(scene);
  assert.ok(scene.getMeshByName("buildingInteriors"));
  assert.equal(merged.metadata.loadedInteriorCount, 1);
  assert.equal(merged.metadata.pendingInteriorCount, 0);

  scene.dispose();
  engine.dispose();
});

test("near windows become transparent while other tile interiors remain pending", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const nearby = ProceduralBuildingRenderer.createDetailed(
    scene,
    plan(124, { render_height: 9.3, levels: 3 }),
    terrain,
    options,
  );
  const distantFootprint = {
    outer: footprint.outer.map(([x, y]) => [x + 0.35, y]),
    holes: [],
  };
  const distant = ProceduralBuildingRenderer.createDetailed(
    scene,
    planBuilding({
      id: "building/14/125/0",
      polygon: distantFootprint,
      properties: { render_height: 9.3, levels: 3 },
    }),
    terrain,
    options,
  );
  assert.ok(nearby && distant);
  const merged = ProceduralBuildingRenderer.merge(
    [nearby, distant],
    "buildings",
    new TransformNode("root", scene),
  );
  assert.ok(merged);
  scene.activeCamera = new FreeCamera("camera", new Vector3(0, 15, 0), scene);

  scene.onAfterRenderObservable.notifyObservers(scene);
  merged.onBeforeRenderObservable.notifyObservers(merged);

  assert.equal(merged.metadata.loadedInteriorCount, 1);
  assert.equal(merged.metadata.pendingInteriorCount, 1);
  const positions = merged.getVerticesData(VertexBuffer.PositionKind);
  const colors = merged.getVerticesData(VertexBuffer.ColorKind);
  const nearbyWindowAlpha = [];
  const distantWindowAlpha = [];
  for (let vertex = 0; vertex < colors.length / 4; vertex++) {
    const alpha = colors[vertex * 4 + 3];
    if (alpha >= 0.999) continue;
    const x = positions[vertex * 3];
    (x < 17.5 ? nearbyWindowAlpha : distantWindowAlpha).push(alpha);
  }
  assert.ok(nearbyWindowAlpha.length > 0);
  assert.equal(distantWindowAlpha.length, 0);

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

test("fits planned stairs inside a clipped stair room", () => {
  const stairRoom = {
    outer: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }],
  };
  const stair = stairLayoutFromPlan({
    buildingType: "house",
    boundary: stairRoom,
    rooms: [{ id: "stairs-1", type: "stairs", polygon: stairRoom }],
  }, options);
  assert.ok(stair);
  const corners = [
    [-0.84, -stair.widthMeters / 2],
    [stair.runMeters + 0.84, -stair.widthMeters / 2],
    [stair.runMeters + 0.84, stair.widthMeters / 2],
    [-0.84, stair.widthMeters / 2],
  ].map(([along, across]) => ({
    x: stair.start.x + stair.direction.x * along + stair.inward.x * across,
    y: stair.start.z + stair.direction.z * along + stair.inward.z * across,
  }));
  assert.ok(corners.every((point) => pointInPolygon(point, stairRoom.outer)));
});

test("rejects a stair room that fits treads but has no room for landings", () => {
  const boundary = { outer: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 3, y: 3 }, { x: 0, y: 3 }] };
  assert.equal(stairLayoutFromPlan({
    buildingType: "house", boundary,
    rooms: [{ id: "stairs-1", type: "stairs", polygon: boundary }],
  }, options), undefined);
});

test("planned flights leave the stair doorway approach clear at different scene scales", () => {
  const boundary = { outer: [{ x: 0, y: 0 }, { x: 6, y: 0 }, { x: 6, y: 4 }, { x: 0, y: 4 }] };
  for (const metersPerUnit of [1, 10]) {
    const stair = stairLayoutFromPlan({
      buildingType: "house", boundary,
      rooms: [{ id: "stairs-1", type: "stairs", polygon: boundary }],
      openings: [{ id: "stairs-door", type: "door", start: { x: 2.4, y: 0 }, end: { x: 3.6, y: 0 } }],
    }, { ...options, metersPerUnit });
    assert.ok(stair);
    // Sample the complete doorway approach, including the player's width.
    for (let x = 2.1; x <= 3.9; x += 0.1) {
      for (let y = 0; y <= 0.8; y += 0.1) {
        const dx = x - stair.start.x * metersPerUnit;
        const dz = y - stair.start.z * metersPerUnit;
        const along = dx * stair.direction.x + dz * stair.direction.z;
        const across = dx * stair.inward.x + dz * stair.inward.z;
        assert.ok(along < 0 || along > stair.runMeters || Math.abs(across) > stair.widthMeters / 2);
      }
    }
  }
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

test("tall buildings remain enterable and include stairs", () => {
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
  assert.equal(tower.metadata.enterable, true);
  assert.equal(tower.metadata.interiorFloorCount, 20);
  assert.equal(tower.metadata.stairFlightCount, 19);
  assert.ok(meshBounds(tower).maximumY >= meshBounds(far).maximumY);
  assert.ok(tower.getTotalVertices() > far.getTotalVertices());

  const merged = ProceduralBuildingRenderer.merge(
    [tower],
    "buildings",
    new TransformNode("root", scene),
  );
  assert.ok(merged.material instanceof MultiMaterial);
  assert.ok(merged.metadata.pendingInteriorCount > 0);

  scene.dispose();
  engine.dispose();
});

test("large city footprints retain entrances and pending interiors", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const building = planBuilding({
    id: "large-city-block",
    polygon: { outer: [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9], [0.1, 0.1]], holes: [] },
    properties: { render_height: 6.2, levels: 2 },
  });
  const mesh = ProceduralBuildingRenderer.createDetailed(scene, building, terrain, options);
  assert.equal(mesh.metadata.detailFallback, undefined);
  assert.equal(mesh.metadata.enterable, true);
  assert.ok(mesh.metadata.pendingInterior);
  assert.equal(mesh.metadata.interiorFloorCount, 2);
  assert.equal(mesh.metadata.stairFlightCount, 1);
  scene.dispose();
  engine.dispose();
});

test("interior construction is limited across all tile chunks in a frame", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const chunks = [123, 124, 125].map((id) => ProceduralBuildingRenderer.merge([
    ProceduralBuildingRenderer.createDetailed(scene,
      plan(id, { render_height: 3.1, levels: 1 }), terrain, options),
  ], "buildings", new TransformNode(`tile-${id}`, scene)));
  scene.activeCamera = new FreeCamera("camera", new Vector3(0, 15, 0), scene);
  scene.onAfterRenderObservable.notifyObservers(scene);
  assert.equal(chunks.reduce((sum, chunk) => sum + chunk.metadata.loadedInteriorCount, 0), 1);
  assert.equal(chunks.reduce((sum, chunk) => sum + chunk.metadata.pendingInteriorCount, 0), 2);
  scene.dispose();
  engine.dispose();
});

test("small-footprint high-rises keep fallback stairs on every floor", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const narrowTower = ProceduralBuildingRenderer.createDetailed(
    scene,
    planBuilding({
      id: "building/14/457/0",
      polygon: {
        outer: [[0.46, 0.46], [0.54, 0.46], [0.54, 0.54], [0.46, 0.54], [0.46, 0.46]],
        holes: [],
      },
      properties: { render_height: 60, levels: 20 },
    }),
    terrain,
    options,
  );
  assert.ok(narrowTower);
  assert.equal(narrowTower.metadata.interiorFloorCount, 20);
  assert.equal(narrowTower.metadata.stairFlightCount, 19);

  narrowTower.dispose(false, true);
  scene.dispose();
  engine.dispose();
});

test("compact fallback stairs preserve two meters of headroom beneath the next flight", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const building = ProceduralBuildingRenderer.createDetailed(scene, planBuilding({
      id: "compact-stair-headroom",
      polygon: {
        outer: [[0.4775, 0.485], [0.5225, 0.485], [0.5225, 0.515], [0.4775, 0.515], [0.4775, 0.485]],
        holes: [],
      },
      properties: { render_height: 9.3, levels: 3, roof_shape: "flat" },
    }), terrain, options);
    assert.ok(building);
    assert.equal(building.metadata.plannedInterior, false);
    assert.equal(building.metadata.stairFlightCount, 2);
    assert.deepEqual(building.metadata.stairFlightCenters[0], building.metadata.stairFlightCenters[1]);
    const interior = building.metadata.pendingInterior.load();
    assert.ok(interior);
    interior.computeWorldMatrix(true);
    const center = building.metadata.stairFlightCenters[0];
    const tread = interior.intersects(new Ray(new Vector3(center.x, 13, center.z), new Vector3(0, -1, 0), 3));
    assert.ok(tread.hit && tread.pickedPoint);
    const headroom = interior.intersects(new Ray(tread.pickedPoint.add(new Vector3(0, 0.02, 0)), new Vector3(0, 1, 0), 2));
    assert.equal(headroom.hit, false, "the upper flight must not block a player standing on the lower flight");
  } finally {
    scene.dispose();
    engine.dispose();
  }
});
