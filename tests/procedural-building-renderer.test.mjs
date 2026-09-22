import assert from "node:assert/strict";
import test from "node:test";
import { advanceInteriorFrame, drainInteriorBuilds } from "./interior-streaming-helpers.mjs";
import {
  FreeCamera,
  Material,
  MultiMaterial,
  NullEngine,
  Ray,
  Scene,
  TransformNode,
  UniversalCamera,
  Vector3,
  VertexBuffer,
} from "@babylonjs/core";
import { moveWalkerWithCollisions } from "../src/app/WalkerCollision.ts";
import { lonLatToScene } from "../src/world/Geo.ts";

const { planBuilding } = await import("../src/buildings/BuildingPlanner.ts");
const { ProceduralBuildingRenderer, stairLayoutFromPlan } = await import(
  "../src/procedural/ProceduralBuildingRenderer.ts"
);
const { BUILDING_MATERIAL_VERTEX_KIND, isRoofSurfaceId } = await import(
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

test("touching buildings keep their facade thickness inside the shared boundary", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const neighbor = {
    outer: [[0.65, 0.42], [0.95, 0.42], [0.95, 0.58], [0.65, 0.58], [0.65, 0.42]],
    holes: [],
  };
  try {
    for (const scale of [1, 10]) {
      for (const polygon of [footprint, neighbor]) {
        const building = planBuilding({ id: `clearance-${polygon.outer[0][0]}`,
          polygon, properties: { render_height: 12, roof_shape: "flat" } });
        const mesh = ProceduralBuildingRenderer.createDetailed(scene, building, terrain, {
          meshWidth: 100 / scale, meshDepth: 100 / scale, metersPerUnit: scale,
          neighboringBuildingFootprints: [footprint, neighbor],
        });
        const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
        let checked = 0;
        for (let i = 0; i < positions.length; i += 3) {
          const y = (positions[i + 1] + mesh.position.y) * scale;
          if (y <= 10.5 || y >= 21.5) continue;
          const x = (positions[i] + mesh.position.x) * scale;
          assert.ok(polygon === footprint ? x <= 14.981 : x >= 15.019,
            `facade vertex ${x} must leave clearance at the shared boundary`);
          checked++;
        }
        assert.ok(checked > 0);
        mesh.dispose(false, true);
      }
    }
  } finally { scene.dispose(); engine.dispose(); }
});

test("high-rise facade faces upload in bounded batches rather than one mesh per panel", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    let uploads = 0;
    const addMesh = scene.addMesh.bind(scene);
    scene.addMesh = (mesh, ...args) => {
      if (mesh.name === "buildingWindows") uploads++;
      return addMesh(mesh, ...args);
    };
    const mesh = ProceduralBuildingRenderer.createDetailed(scene,
      plan(321, { render_height: 90, levels: 30, roof_shape: "flat" }), terrain, options);
    assert.ok(mesh.metadata.windowCount > 100, "the full high-rise retains its windows");
    assert.ok(uploads > 0 && uploads < 30, `expected batched wall/window uploads, got ${uploads}`);
  } finally { scene.dispose(); engine.dispose(); }
});

test("flat roof caps reach the outside faces of the facade walls", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    for (const scale of [1, 10]) {
      const mesh = ProceduralBuildingRenderer.createDetailed(scene,
        plan(123, { render_height: 12, roof_shape: "flat" }), terrain,
        { meshWidth: 100 / scale, meshDepth: 100 / scale, metersPerUnit: scale });
      mesh.setEnabled(true);
      mesh.computeWorldMatrix(true);
      const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
      const normals = mesh.getVerticesData(VertexBuffer.NormalKind);
      const surfaces = mesh.getVerticesData(BUILDING_MATERIAL_VERTEX_KIND);
      let roofSideVertices = 0;
      for (let vertex = 0; vertex < positions.length / 3; vertex++) {
        if (!isRoofSurfaceId(Math.round(surfaces[vertex * 2])) ||
            Math.abs(normals[vertex * 3 + 1]) > 0.01) continue;
        roofSideVertices++;
        const elevation = (positions[vertex * 3 + 1] + mesh.position.y) * scale;
        assert.ok(elevation >= 22 - 1e-5, "roof sides must not overlap the facade below the wall top");
      }
      assert.ok(roofSideVertices > 0);
      for (const [x, z] of [[-15.1, 0], [15.1, 0], [0, -8.1], [0, 8.1]]) {
        const hit = scene.pickWithRay(new Ray(new Vector3(x / scale, 22.5 / scale, z / scale),
          Vector3.Down(), 0.5 / scale), (child) => child === mesh);
        assert.equal(hit?.hit, true, "roof covers the outer wall thickness");
        assert.ok(hit.pickedPoint.y * scale > 22.09, "ray reaches the cap above the wall");
      }
      assert.equal(mesh.getChildMeshes().filter((child) => child.metadata?.buildingDoor).length,
        mesh.metadata.roofAccess ? 1 : 0, "roof doors require a reachable stair flight");
      mesh.dispose(false, true);
    }
  } finally {
    scene.dispose();
    engine.dispose();
  }
});

test("unloaded courtyard roofs meet the outer facade without a perimeter gap", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    for (const scale of [1, 10]) {
      const building = plan(123, { render_height: 12, roof_shape: "flat" });
      building.footprint = { ...building.footprint,
        holes: [[[0.45, 0.46], [0.55, 0.46], [0.55, 0.54], [0.45, 0.54], [0.45, 0.46]]] };
      const mesh = ProceduralBuildingRenderer.createDetailed(scene, building, terrain,
        { meshWidth: 100 / scale, meshDepth: 100 / scale, metersPerUnit: scale });
      mesh.computeWorldMatrix(true);
      const south = lonLatToScene(0.5, 0.42, terrain.bounds, 100, 100).z;
      const north = lonLatToScene(0.5, 0.58, terrain.bounds, 100, 100).z;
      for (const [x, z] of [[-15.06, 0], [15.06, 0], [0, south - 0.06], [0, north + 0.06]]) {
        const hit = new Ray(new Vector3(x / scale, 22.02 / scale, z / scale),
          Vector3.Down(), 0.04 / scale).intersectsMesh(mesh);
        assert.ok(hit.hit, `roof joins the facade at ${x}, ${z}, scale ${scale}`);
      }
      assert.equal(mesh.metadata.interiorsLoaded, false);
      mesh.dispose(false, true);
    }
  } finally {
    scene.dispose();
    engine.dispose();
  }
});

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
  assert.equal(detailed.metadata.enterable, true);
  assert.ok(detailed.metadata.pendingInterior);
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
    drainInteriorBuilds(scene);
    assert.equal(merged.metadata.loadedInteriorCount, 0);
    assert.equal(scene.getMeshByName("buildingInteriors"), null);
    root.position.x = 1000;
    root.computeWorldMatrix(true);
    root.setEnabled(true);
    camera.position.x = 1000;
    camera.getViewMatrix(true);
    drainInteriorBuilds(scene);
    assert.equal(merged.metadata.loadedInteriorCount, 1);
  } finally {
    scene.dispose();
    engine.dispose();
  }
});

test("unloaded facades keep windows and entrance covers flush with the shell", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    for (const scale of [1, 10]) {
      const detailed = ProceduralBuildingRenderer.createDetailed(scene,
        plan(123, { render_height: 9.3, levels: 3 }), terrain,
        { meshWidth: 100 / scale, meshDepth: 100 / scale, metersPerUnit: scale, showRoofs: false });
      const positions = detailed.getVerticesData(VertexBuffer.PositionKind);
      const facadeZ = lonLatToScene(0.5, 0.42, terrain.bounds, 100, 100).z - 0.12;
      let facadeVertices = 0;
      for (let i = 0; i < positions.length; i += 3) {
        const x = (positions[i] + detailed.position.x) * scale;
        const y = (positions[i + 1] + detailed.position.y) * scale;
        const z = (positions[i + 2] + detailed.position.z) * scale;
        if (Math.abs(x) >= 14 || y <= 10.01 || y >= 19.29 || z >= -7) continue;
        facadeVertices++;
        assert.ok(Math.abs(z - facadeZ) < 0.002, `facade vertex is recessed at ${z}`);
      }
      assert.ok(facadeVertices > 0);
      detailed.setEnabled(true);
      const pending = detailed.metadata.pendingInterior;
      const gate = pending.createGate(detailed);
      const doors = gate.getChildMeshes().find((mesh) => mesh.name === "buildingShellDoors");
      assert.ok(doors);
      assert.equal(doors.getTotalVertices(), 4);
      assert.equal(doors.getTotalIndices(), 6);
      assert.equal(doors.isEnabled(), true);
      const doorPositions = doors.getVerticesData(VertexBuffer.PositionKind);
      const doorWorld = doors.computeWorldMatrix(true);
      const elevations = [];
      for (let i = 0; i < doorPositions.length; i += 3) {
        elevations.push(Vector3.TransformCoordinates(Vector3.FromArray(doorPositions, i), doorWorld).y * scale);
      }
      assert.ok(Math.abs(Math.min(...elevations) - terrain.minElevation) < 0.002,
        `entrance cover must start at ground level, got ${Math.min(...elevations)}`);
      assert.ok(Math.max(...elevations) < terrain.minElevation + 2.3,
        "entrance cover must remain at door height, not above the roof");
      gate.setEnabled(false);
      assert.equal(doors.isEnabled(), false);
      detailed.dispose(false, true);
    }
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
  drainInteriorBuilds(scene);
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

  drainInteriorBuilds(scene);
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
    outer: [{ x: 0, y: 0 }, { x: 6, y: 0 }, { x: 5, y: 4 }, { x: 0, y: 4 }],
  };
  const stair = stairLayoutFromPlan({
    buildingType: "house",
    boundary: stairRoom,
    rooms: [{ id: "stairs-1", type: "stairs", polygon: stairRoom }],
  }, options);
  assert.ok(stair);
  assert.ok(stair.widthMeters >= 1.6, "flights must leave room to steer");
  const corners = [
    [-0.99, -stair.widthMeters / 2],
    [stair.runMeters + 0.99, -stair.widthMeters / 2],
    [stair.runMeters + 0.99, stair.widthMeters / 2],
    [-0.99, stair.widthMeters / 2],
  ].map(([along, across]) => ({
    x: stair.start.x + stair.direction.x * along + stair.inward.x * across,
    y: stair.start.z + stair.direction.z * along + stair.inward.z * across,
  }));
  assert.ok(corners.every((point) => pointInPolygon(point, stairRoom.outer)));
});

test("rejects narrow stair cores instead of squeezing the flight", () => {
  const boundary = { outer: [{ x: 0, y: 0 }, { x: 6, y: 0 }, { x: 6, y: 1.8 }, { x: 0, y: 1.8 }] };
  assert.equal(stairLayoutFromPlan({
    buildingType: "house", boundary,
    rooms: [{ id: "stairs-1", type: "stairs", polygon: boundary }],
  }, options), undefined);
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
  advanceInteriorFrame(scene);
  assert.equal(chunks.reduce((sum, chunk) => sum + chunk.metadata.loadedInteriorCount, 0), 0);
  assert.equal(chunks.reduce((sum, chunk) => sum + chunk.metadata.loadingInteriorCount, 0), 3);
  drainInteriorBuilds(scene, () => chunks.some((chunk) => chunk.metadata.loadedInteriorCount === 1));
  assert.equal(chunks.reduce((sum, chunk) => sum + chunk.metadata.loadedInteriorCount, 0), 1);
  assert.equal(chunks.reduce((sum, chunk) => sum + chunk.metadata.pendingInteriorCount, 0), 2);
  scene.dispose();
  engine.dispose();
});

test("leaving mid-build cleans up staged meshes and returning can finish the interior", (t) => {
  let clock = 0;
  t.mock.method(performance, "now", () => ++clock);
  const engine = new NullEngine(), scene = new Scene(engine);
  try {
    const parent = new TransformNode("tile", scene);
    const exterior = ProceduralBuildingRenderer.merge([
      ProceduralBuildingRenderer.createDetailed(scene,
        plan(123, { render_height: 12.4, levels: 4 }), terrain, options),
    ], "buildings", parent);
    const baseline = new Set(scene.meshes);
    const materials = new Set(scene.materials);
    const camera = new FreeCamera("camera", new Vector3(0, 15, 0), scene);
    scene.activeCamera = camera;
    for (let frame = 0; frame < 20; frame++) { clock += 16; advanceInteriorFrame(scene); }
    assert.equal(exterior.metadata.loadingInteriorCount, 1);
    assert.equal(exterior.metadata.loadedInteriorCount, 0);
    const staged = scene.getMeshByName("buildingInteriorRoot");
    assert.ok(staged);
    assert.equal(staged.isEnabled(), false);
    camera.position.x = 1000;
    camera.getViewMatrix(true);
    clock += 16;
    advanceInteriorFrame(scene);
    assert.equal(staged.isDisposed(), true);
    assert.equal(exterior.metadata.loadingInteriorCount, 0);
    assert.equal(exterior.metadata.pendingInteriorCount, 1);
    assert.deepEqual(new Set(scene.meshes), baseline, "no orphan source meshes or completed batches");
    assert.deepEqual(new Set(scene.materials), materials, "cancelled batches release their materials");

    camera.position.x = 0;
    camera.getViewMatrix(true);
    clock += 150;
    const frames = drainInteriorBuilds(scene);
    assert.ok(frames > 1);
    assert.equal(exterior.metadata.loadedInteriorCount, 1);
    assert.equal(exterior.metadata.pendingInteriorCount, 1, "remote floors remain deferred");
    const loadedRoot = scene.meshes.find((mesh) => mesh.name === "buildingInteriorRoot" && mesh.metadata.interiorReady);
    const chunks = loadedRoot.getChildMeshes().filter((mesh) => mesh.name !== "buildingFurnitureRoot");
    assert.ok(chunks.length > 1, "interior remains in bounded merge batches");
    assert.ok(chunks.every((mesh) => mesh.getTotalVertices() <= 4096));
    assert.ok(chunks.every((mesh) => mesh.isEnabled() && mesh.checkCollisions));
    exterior.dispose(false, true);
    assert.equal(loadedRoot.isDisposed(), true, "exterior disposal also owns its loaded interior");
  } finally { scene.dispose(); engine.dispose(); }
});

test("disposing a tile while its interior is queued or building leaves no orphan geometry", (t) => {
  t.mock.method(performance, "now", () => 0);
  const engine = new NullEngine(), scene = new Scene(engine);
  try {
    scene.activeCamera = new FreeCamera("camera", new Vector3(0, 15, 0), scene);
    const roots = [0, 1].map((index) => {
      const parent = new TransformNode(`tile-${index}`, scene);
      ProceduralBuildingRenderer.merge([
        ProceduralBuildingRenderer.createDetailed(scene,
          plan(123 + index, { render_height: 12.4, levels: 4 }), terrain, options),
      ], "buildings", parent);
      return parent;
    });
    for (let frame = 0; frame < 10; frame++) advanceInteriorFrame(scene);
    for (const root of roots) root.dispose(false, true);
    for (let frame = 0; frame < 10; frame++) advanceInteriorFrame(scene);
    assert.equal(scene.meshes.length, 0);
  } finally { scene.dispose(); engine.dispose(); }
});

test("unfinished interiors stay hidden and block walking and flying until an atomic completion", (t) => {
  let clock = 0;
  t.mock.method(performance, "now", () => clock);
  const engine = new NullEngine(), scene = new Scene(engine);
  try {
    scene.collisionsEnabled = true;
    const exterior = ProceduralBuildingRenderer.merge([
      ProceduralBuildingRenderer.createDetailed(scene,
        plan(123, { render_height: 12.4, levels: 4 }), terrain, options),
    ], "buildings", new TransformNode("tile", scene));
    const gate = scene.getMeshByName("buildingInteriorGate");
    assert.ok(gate?.checkCollisions && gate.isEnabled());
    assert.equal(gate.isVisible, false);
    gate.computeWorldMatrix(true);
    const camera = new UniversalCamera("walker", new Vector3(0, 11.5, -10), scene);
    scene.activeCamera = camera;
    camera.checkCollisions = true;
    camera.ellipsoid.set(0.3, 0.6, 0.3);
    // Isolate the new gate from the existing facade collision surfaces.
    exterior.checkCollisions = false;
    moveWalkerWithCollisions(camera, 0, 4);
    assert.ok(camera.position.z < -8.2, `entry gate did not stop the walker: ${camera.position.z}`);

    camera.checkCollisions = false;
    camera.position.set(0, 11.5, 0);
    camera.getViewMatrix(true);
    scene.onBeforeCameraRenderObservable.notifyObservers(camera);
    assert.ok(Math.abs(camera.position.x) > 15 || Math.abs(camera.position.z) > 8,
      "fly mode and a saved pose must not enter an unfinished interior");
    assert.ok(scene.getViewMatrix().equals(camera.getViewMatrix()), "the same frame uses the corrected view");
    let frames = 0;
    do {
      advanceInteriorFrame(scene);
      const root = scene.getMeshByName("buildingInteriorRoot");
      assert.ok(root);
      if (exterior.metadata.loadedInteriorCount === 0) {
        assert.equal(root.isEnabled(), false);
        assert.ok(root.getChildMeshes().every((mesh) => !mesh.isEnabled()),
          "even pre-enabled child batches stay hidden behind their disabled root");
        assert.equal(gate.isEnabled(), true);
      }
      assert.ok(++frames < 20000);
    } while (exterior.metadata.loadedInteriorCount === 0);
    assert.ok(frames > 1);
    const root = scene.meshes.find((mesh) => mesh.name === "buildingInteriorRoot" && mesh.metadata.interiorReady);
    assert.equal(root.metadata.interiorReady, true);
    assert.ok(root.getChildMeshes().filter((mesh) => mesh.name !== "buildingFurnitureRoot").every((mesh) => mesh.isEnabled()));
    assert.equal(root.metadata.furnitureReady, false, "entry does not wait for furniture");
    assert.equal(gate.isEnabled(), false);
    camera.position.set(0, 11.5, 0);
    camera.getViewMatrix(true);
    scene.onBeforeCameraRenderObservable.notifyObservers(camera);
    assert.equal(camera.position.x, 0);
    assert.equal(camera.position.z, 0);

    camera.position.x = 1000;
    camera.getViewMatrix(true);
    clock += 150;
    advanceInteriorFrame(scene);
    assert.equal(root.isDisposed(), true);
    assert.equal(gate.isEnabled(), true, "unloading closes entry again");
  } finally { scene.dispose(); engine.dispose(); }
});

test("all nearby buildings in one chunk are queued and focus follows their actual footprints", (t) => {
  t.mock.method(performance, "now", () => 0);
  const engine = new NullEngine(), scene = new Scene(engine);
  try {
    const buildings = [0, 0.35].map((offset, index) => {
      const polygon = { outer: footprint.outer.map(([x, y]) => [x + offset, y]), holes: [] };
      return ProceduralBuildingRenderer.createDetailed(scene,
        planBuilding({ id: `focus-${index}`, polygon, properties: { render_height: 12.4, levels: 4 } }), terrain, options);
    });
    const exterior = ProceduralBuildingRenderer.merge(buildings, "buildings", new TransformNode("tile", scene));
    const camera = new FreeCamera("camera", new Vector3(17, 11.5, 0), scene);
    scene.activeCamera = camera;
    camera.getViewMatrix(true);
    advanceInteriorFrame(scene);
    assert.equal(exterior.metadata.loadingInteriorCount, 2);
    const roots = [0, 1].map((index) => scene.meshes.find((mesh) =>
      mesh.name === "buildingInteriorRoot" && mesh.metadata.buildingId === `focus-${index}` && mesh.metadata.floorIndex === 0));
    assert.ok(roots.every(Boolean));
    advanceInteriorFrame(scene);
    const firstCount = roots[0].getChildMeshes().length;
    assert.ok(firstCount > 0);
    assert.equal(roots[1].getChildMeshes().length, 0);
    camera.position.x = 18.5;
    camera.getViewMatrix(true);
    advanceInteriorFrame(scene);
    assert.equal(roots[0].getChildMeshes().length, firstCount, "farther building pauses without losing parts");
    assert.ok(roots[1].getChildMeshes().length > 0, "new nearest building starts within a frame");
    assert.ok(roots.every((root) => root.isEnabled() === root.metadata.interiorReady));
  } finally { scene.dispose(); engine.dispose(); }
});

for (const scale of [1, 10]) test(`floors stream around camera height before furniture at scale ${scale}`, (t) => {
  let clock = 0;
  t.mock.method(performance, "now", () => clock);
  const engine = new NullEngine(), scene = new Scene(engine);
  try {
    const tile = new TransformNode("movedTile", scene);
    tile.position.set(100, 7, -200);
    const exterior = ProceduralBuildingRenderer.merge([
      ProceduralBuildingRenderer.createDetailed(scene, plan(123, { render_height: 24.8, levels: 8 }), terrain,
        { meshWidth: 100 / scale, meshDepth: 100 / scale, metersPerUnit: scale }),
    ], "buildings", tile);
    const camera = new FreeCamera("camera", tile.position.add(new Vector3(0, (10 + 4 * 3.1 + 1.5) / scale, 0)), scene);
    scene.activeCamera = camera;
    drainInteriorBuilds(scene, () => exterior.metadata.loadedInteriorFloorCount > 0);
    const loaded = exterior.metadata.loadedInteriors;
    assert.deepEqual(loaded.map((entry) => entry.pending.floor.index), [4], "current floor completes first");
    assert.equal(loaded[0].mesh.metadata.furnitureReady, false);
    assert.ok(loaded[0].mesh.isEnabled());
    assert.equal(exterior.metadata.interiorsLoaded, false);
    assert.equal(scene.meshes.some((mesh) => mesh.name === "buildingInteriorRoot" && mesh.metadata.floorIndex === 0), false,
      "ground floor is not generated when arriving upstairs");
    const children = loaded[0].mesh.getChildMeshes().filter((mesh) => mesh.isEnabled());
    const origin = tile.position.add(new Vector3(-13 / scale, (10 + 4 * 3.1 + 1.5) / scale, -6 / scale));
    for (const direction of [new Vector3(0, -1, 0), new Vector3(0, 1, 0)]) {
      assert.ok(children.some((mesh) => mesh.intersects(Ray.Transform(new Ray(origin, direction, 3 / scale),
        mesh.computeWorldMatrix(true).clone().invert())).hit), "ready floor has both floor and ceiling before adjacent floors finish");
    }
    drainInteriorBuilds(scene);
    assert.deepEqual(loaded.map((entry) => entry.pending.floor.index).sort(), [3, 4, 5]);
    assert.ok(loaded.every((entry) => entry.mesh.metadata.furnitureReady));
    const old = loaded.find((entry) => entry.pending.floor.index === 3).mesh;
    camera.position.y = tile.position.y + (10 + 6 * 3.1 + 1.5) / scale;
    clock += 150;
    drainInteriorBuilds(scene);
    assert.equal(old.isDisposed(), true, "floors outside the vertical retention range unload");
    assert.ok(loaded.some((entry) => entry.pending.floor.index === 6));
    assert.ok(loaded.some((entry) => entry.pending.floor.index === 7));
    assert.equal(loaded.some((entry) => entry.pending.floor.index < 4), false);
    tile.dispose(false, true);
    advanceInteriorFrame(scene);
    assert.equal(scene.meshes.length, 0);
  } finally { scene.dispose(); engine.dispose(); }
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

for (const scale of [1, 10]) test(`stair runs account for floor height at scale ${scale}`, () => {
  const boundary = { outer: [{ x: 0, y: 0 }, { x: 12, y: 0 }, { x: 12, y: 4 }, { x: 0, y: 4 }], holes: [] };
  const layout = { boundary, rooms: [{ id: "stairs-1", type: "stairs", polygon: boundary }], openings: [] };
  const stair = stairLayoutFromPlan(layout, { ...options, metersPerUnit: scale }, 8);
  assert.ok(stair);
  assert.ok(stair.runMeters >= 8, "tall floors require a longer flight even beyond the usual run cap");
  assert.equal(stairLayoutFromPlan(layout, { ...options, metersPerUnit: scale }, 11), undefined,
    "reject flights that cannot fit both a safe slope and landings");
});

test("compact footprints reject steep fallback stairs", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const building = ProceduralBuildingRenderer.createDetailed(scene, planBuilding({
      id: "steep-stair-regression",
      polygon: {
        outer: [[0.4775, 0.485], [0.5225, 0.485], [0.5225, 0.515], [0.4775, 0.515], [0.4775, 0.485]],
        holes: [],
      },
      properties: { render_height: 9.3, levels: 3, roof_shape: "flat" },
    }), terrain, options);
    assert.ok(building);
    assert.equal(building.metadata.stairFlightCount, 0);
    assert.deepEqual(building.metadata.stairFlightCenters, []);
  } finally { scene.dispose(); engine.dispose(); }
});

test("compact fallback stairs preserve two meters of headroom beneath the next flight", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const building = ProceduralBuildingRenderer.createDetailed(scene, planBuilding({
      id: "compact-stair-headroom",
      polygon: {
        outer: [[0.4725, 0.485], [0.5275, 0.485], [0.5275, 0.515], [0.4725, 0.515], [0.4725, 0.485]],
        holes: [],
      },
      properties: { render_height: 9.3, levels: 3, roof_shape: "flat" },
    }), terrain, options);
    assert.ok(building);
    assert.equal(building.metadata.plannedInterior, false);
    assert.equal(building.metadata.stairFlightCount, 2);
    assert.deepEqual(building.metadata.stairFlightCenters[0], building.metadata.stairFlightCenters[1]);
    const interior = new TransformNode("testInterior", scene);
    for (const _stage of building.metadata.pendingInterior.build(interior)) { /* Drain geometry for ray checks. */ }
    const intersect = (ray) => interior.getChildMeshes().map((mesh) => {
      mesh.computeWorldMatrix(true);
      return mesh.intersects(ray);
    }).filter((hit) => hit.hit).sort((a, b) => a.distance - b.distance)[0];
    const center = building.metadata.stairFlightCenters[0];
    const tread = intersect(new Ray(new Vector3(center.x, 13, center.z), new Vector3(0, -1, 0), 3));
    assert.ok(tread.hit && tread.pickedPoint);
    const headroom = intersect(new Ray(tread.pickedPoint.add(new Vector3(0, 0.02, 0)), new Vector3(0, 1, 0), 2));
    assert.equal(headroom, undefined, "the upper flight must not block a player standing on the lower flight");
  } finally {
    scene.dispose();
    engine.dispose();
  }
});
