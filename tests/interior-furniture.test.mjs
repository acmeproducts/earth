import assert from "node:assert/strict";
import test from "node:test";
import { NullEngine, Scene, VertexBuffer, Mesh } from "@babylonjs/core";
import { planInteriorFurniture, createInteriorFurniture } from "../src/procedural/InteriorFurniture.ts";

function layout(type, transform = (p) => p) {
  const polygon = { outer: [{ x: 0, y: 0 }, { x: 6, y: 0 }, { x: 6, y: 5 }, { x: 0, y: 5 }].map(transform) };
  return { boundary: polygon, rooms: [{ id: "test", type, polygon }], openings: [
    { id: "door", type: "door", start: transform({ x: 2.5, y: 0 }), end: transform({ x: 3.5, y: 0 }) },
    { id: "window", type: "window", start: transform({ x: 1, y: 5 }), end: transform({ x: 5, y: 5 }) },
  ] };
}

test("assigned rooms receive their fixtures and shared artwork", () => {
  for (const [type, expected] of [
    ["toilet", ["toilet", "sink", "painting"]],
    ["kitchen", ["stove", "sink", "counter", "fridge", "painting"]],
    ["living-room", ["dining", "sofa", "bookcase", "painting"]],
    ["room", ["dining", "sofa"]],
  ]) {
    const source = layout(type);
    const props = planInteriorFurniture(source);
    for (const kind of expected) assert.ok(props.some((p) => p.kind === kind), `${type}: ${kind}`);
    assert.deepEqual(props, planInteriorFurniture(source));
    for (const prop of props) for (const p of prop.footprint) {
      assert.ok(p.x >= 0.13 && p.x <= 5.87 && p.y >= 0.13 && p.y <= 4.87);
    }
    // The 90 cm approach in front of the entry must remain empty.
    for (const prop of props) {
      const xs = prop.footprint.map((p) => p.x), ys = prop.footprint.map((p) => p.y);
      assert.ok(Math.min(...ys) >= 0.9 || Math.max(...xs) < 2.5 || Math.min(...xs) > 3.5);
    }
  }
});

test("furniture follows rotated and translated rooms", () => {
  const angle = 0.63;
  const transform = (p) => ({ x: 80 + p.x * Math.cos(angle) - p.y * Math.sin(angle), y: -20 + p.x * Math.sin(angle) + p.y * Math.cos(angle) });
  const original = planInteriorFurniture(layout("kitchen"));
  const rotated = planInteriorFurniture(layout("kitchen", transform));
  assert.deepEqual(rotated.map((p) => p.kind), original.map((p) => p.kind));
  original.forEach((prop, i) => {
    const expected = transform(prop.center);
    assert.ok(Math.hypot(expected.x - rotated[i].center.x, expected.y - rotated[i].center.y) < 1e-7);
  });
});

test("unfurnishable rooms skip props instead of spilling through walls", () => {
  const source = layout("living-room", (p) => ({ x: p.x / 10, y: p.y / 10 }));
  assert.deepEqual(planInteriorFurniture(source), []);
});

test("furniture mesh scales with terrain, stays below ceiling, and survives merging", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const props = ["toilet", "kitchen", "living-room"].flatMap((type) => planInteriorFurniture(layout(type)));
    const mesh = createInteriorFurniture(scene, props, 12, 2, 2.5, 42);
    assert.ok(mesh && !mesh.isEnabled());
    const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
    assert.ok(positions.every(Number.isFinite));
    for (let i = 1; i < positions.length; i += 3) assert.ok(positions[i] >= 6 && positions[i] < 7.25);
    assert.equal(mesh.getVerticesData(VertexBuffer.ColorKind).length, mesh.getTotalVertices() * 4);
    assert.equal(mesh.getVerticesData(VertexBuffer.UV2Kind).length, mesh.getTotalVertices() * 2);
    const merged = Mesh.MergeMeshes([mesh], false, true);
    assert.equal(merged.getTotalVertices(), mesh.getTotalVertices());
  } finally { scene.dispose(); engine.dispose(); }
});
