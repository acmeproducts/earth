// Run with: yarn node --import ./tests/register-typescript.mjs --test tests/rock-mesh-shape.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { readFileSync } from "node:fs";

// RockField pulls in WorldCover's enum, which needs transformation rather than
// the runner's plain type stripping, and a raster decoder whose browser entry
// cannot load in Node and is never exercised here.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "lerc") return {
      url: "data:text/javascript,export function decode(){throw new Error('Unexpected raster decode')} export function load(){throw new Error('Unexpected raster load')}",
      shortCircuit: true,
    };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith("/WorldCover.ts")) {
      return { format: "module", shortCircuit: true,
        source: stripTypeScriptTypes(readFileSync(new URL(url), "utf8"), { mode: "transform" }) };
    }
    return nextLoad(url, context);
  },
});

const { NullEngine, Scene, VertexBuffer } = await import("@babylonjs/core");
const { createRockMesh, createRockField } = await import("../src/vegetation/RockField.ts");
const { habitatField } = await import("../src/vegetation/HabitatNoise.ts");
const { sceneToLonLat } = await import("../src/world/Geo.ts");

const engine = new NullEngine();
const scene = new Scene(engine);
engine.getCaps().instancedArrays = true;

/** Per-face geometric normal and the shading normals it was given. */
function analyse(mesh) {
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
  const normals = mesh.getVerticesData(VertexBuffer.NormalKind);
  const indices = mesh.getIndices();
  let hardVertices = 0;
  let smoothVertices = 0;
  let flipped = 0;
  const faceNormals = [];
  for (let face = 0; face < indices.length; face += 3) {
    const [a, b, c] = [indices[face], indices[face + 1], indices[face + 2]];
    const ab = [0, 1, 2].map(k => positions[b * 3 + k] - positions[a * 3 + k]);
    const ac = [0, 1, 2].map(k => positions[c * 3 + k] - positions[a * 3 + k]);
    // Babylon's ComputeNormals winds faces the opposite way from the usual
    // right-handed cross product, hence the negation.
    const n = [
      -(ab[1] * ac[2] - ab[2] * ac[1]),
      -(ab[2] * ac[0] - ab[0] * ac[2]),
      -(ab[0] * ac[1] - ab[1] * ac[0]),
    ];
    const length = Math.hypot(...n) || 1;
    const faceNormal = n.map(v => v / length);
    faceNormals.push(faceNormal);
    for (const vertex of [a, b, c]) {
      const shading = [normals[vertex * 3], normals[vertex * 3 + 1], normals[vertex * 3 + 2]];
      const dot = shading[0] * faceNormal[0] + shading[1] * faceNormal[1] + shading[2] * faceNormal[2];
      if (dot < 0) flipped++;
      if (dot > 0.9999) hardVertices++;
      else smoothVertices++;
    }
  }
  return {
    faces: indices.length / 3,
    hardShare: hardVertices / (indices.length),
    smoothShare: smoothVertices / (indices.length),
    flipped,
  };
}

test("rounded stones are smoothly shaded with outward normals", () => {
  const stats = analyse(createRockMesh(scene, 0, false));
  assert.equal(stats.flipped, 0);
  assert.ok(stats.smoothShare > 0.95, `only ${stats.smoothShare} of vertex normals are smoothed`);
});

test("blocky stones mix hard fracture facets with a smoothed body", () => {
  for (const variant of [3, 4]) {
    const stats = analyse(createRockMesh(scene, variant, false));
    assert.equal(stats.flipped, 0, `variant ${variant} has inward normals`);
    assert.ok(
      stats.hardShare > 0.15,
      `variant ${variant}: only ${stats.hardShare.toFixed(2)} of shading normals sit on flat facets`,
    );
    assert.ok(
      stats.smoothShare > 0.25,
      `variant ${variant}: only ${stats.smoothShare.toFixed(2)} of shading normals are smoothed`,
    );
  }
});

async function placedRocks({ cover = 60, slope = 0, densityScale, exclusionMask } = {}) {
  const span = 2400;
  const terrain = {
    width: 2, height: 2,
    elevations: new Float32Array([2000 - slope * span / 2, 2000 + slope * span / 2,
      2000 - slope * span / 2, 2000 + slope * span / 2]),
    bounds: { lonWest: 8.5, lonEast: 8.532, latSouth: 47.3, latNorth: 47.322 },
  };
  const field = await createRockField(scene, terrain, {
    meshWidth: span, meshDepth: span, metersPerUnit: 1,
    seed: 123, modelVariantSeed: 456, landCover: { sample: () => cover },
    densityScale, exclusionMask,
  });
  const points = field.meshes.flatMap(mesh => mesh.thinInstanceGetWorldMatrices().map(matrix => ({
    x: matrix.m[12], z: matrix.m[14], radius: Math.hypot(...matrix.m.slice(0, 3)),
  })));
  field.root.dispose(false, true);
  return { points, terrain, span };
}

test("inland deposits leave habitat gaps empty even on stony covers", async () => {
  const habitat = habitatField("rocks", 456, {
    patchMeters: 600, abundanceMeters: 2800, barrenShare: 0.5, richestCoverage: 0.7,
  });
  for (const cover of [60, 70, 100]) {
    const { points, terrain, span } = await placedRocks({ cover });
    assert.ok(points.length > 20, `cover ${cover} must still have deposits`);
    for (const point of points) {
      const { lon, lat } = sceneToLonLat(point.x, point.z, terrain.bounds, span, span);
      assert.ok(habitat.sample(lon, lat) > 0, `cover ${cover} filled an empty habitat`);
    }
    const occupied = new Set(points.map(p => `${Math.floor((p.x + span / 2) / 100)},${Math.floor((p.z + span / 2) / 100)}`));
    assert.ok(occupied.size < 24 * 24 * 0.5, `${occupied.size} of 576 blocks contain rocks`);
  }
});

test("deposits are repeatable, locally grouped, and favor slopes", async () => {
  const flat = (await placedRocks()).points;
  const sloped = (await placedRocks({ slope: 0.65 })).points;
  assert.deepEqual((await placedRocks()).points, flat);
  assert.ok(sloped.length > flat.length * 1.5, `${sloped.length} slope vs ${flat.length} flat`);
  const grouped = flat.filter((p, i) => flat.some((q, j) => i !== j && Math.hypot(p.x - q.x, p.z - q.z) < 10));
  assert.ok(grouped.length > flat.length * 0.9, "stones should have nearby companions");
});

test("formation fragments respect exclusions, density masks, and sand cover", async () => {
  assert.equal((await placedRocks({ densityScale: () => 0 })).points.length, 0);
  assert.equal((await placedRocks({ cover: 61 })).points.length, 0);
  const { points } = await placedRocks({
    densityScale: (x) => x < 0 ? 0 : 1,
    exclusionMask: { intersects: (x, z, radius) => z - radius < 0 },
  });
  assert.ok(points.length > 0);
  assert.ok(points.every(p => p.x >= 0 && p.z >= 0));
});
