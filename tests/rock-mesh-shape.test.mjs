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
const { createRockMesh } = await import("../src/RockField.ts");

const engine = new NullEngine();
const scene = new Scene(engine);

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
