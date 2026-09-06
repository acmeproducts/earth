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

test("seeded apartments vary placement while retaining door clearance and repeatability", () => {
  const source = layout("living-room");
  const arrangements = new Set();
  for (let seed = 1; seed <= 30; seed++) {
    const props = planInteriorFurniture(source, seed);
    assert.deepEqual(props, planInteriorFurniture(source, seed));
    arrangements.add(JSON.stringify(props.map((p) => p.center)));
    for (const prop of props) {
      for (const p of prop.footprint) assert.ok(p.x >= 0.13 && p.x <= 5.87 && p.y >= 0.13 && p.y <= 4.87);
      const xs = prop.footprint.map((p) => p.x), ys = prop.footprint.map((p) => p.y);
      assert.ok(Math.min(...ys) >= 0.9 || Math.max(...xs) < 2.5 || Math.min(...xs) > 3.5);
    }
  }
  assert.ok(arrangements.size > 10);
});

test("commercial suites receive distinct props with finite geometry inside their footprints", () => {
  const engine = new NullEngine(), scene = new Scene(engine);
  try {
    for (const [use, expected] of [
      ["shop", ["checkout", "display"]], ["office", ["desk", "meeting"]],
      ["hotel", ["bed", "desk"]], ["lobby", ["reception", "sofa"]],
      ["education", ["whiteboard", "student-desk"]], ["medical", ["exam-bed", "medical-cabinet", "sink"]],
      ["waiting", ["reception", "bench"]], ["warehouse", ["rack", "pallet"]],
      ["industrial", ["workbench", "rack"]], ["garage", ["parking-bay", "workbench"]],
    ]) {
      const props = planInteriorFurniture(layout("room", (p) => ({ x: p.x * 2, y: p.y * 2 })), 42, use);
      for (const kind of expected) assert.ok(props.some((p) => p.kind === kind), kind);
      assert.ok(!props.some((p) => ["stove", "toilet"].includes(p.kind)));
      for (const prop of props) {
        const mesh = createInteriorFurniture(scene, [prop], 0, 1, 3, 42);
        const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
        assert.ok(positions.every(Number.isFinite));
        for (let i = 0; i < positions.length; i += 3) {
          const x = positions[i] - prop.center.x, z = positions[i + 2] - prop.center.y;
          assert.ok(Math.abs(x * prop.along.x + z * prop.along.y) <= prop.width / 2 + 1e-5);
          assert.ok(Math.abs(x * prop.inward.x + z * prop.inward.y) <= prop.depth / 2 + 1e-5, `${use}: ${prop.kind} depth`);
        }
        mesh.dispose();
      }
    }
    const props = planInteriorFurniture(layout("living-room"), 42);
    const colors = (seed) => createInteriorFurniture(scene, props, 0, 1, 3, seed).getVerticesData(VertexBuffer.ColorKind);
    assert.deepEqual(colors(42), colors(42));
    assert.notDeepEqual(colors(42), colors(43));
  } finally { scene.dispose(); engine.dispose(); }
});

test("classrooms align pupil desks with the board across seeded and rotated layouts", () => {
  const angle = 0.63;
  const transform = (p) => ({ x: 80 + p.x * Math.cos(angle) - p.y * Math.sin(angle), y: -20 + p.x * Math.sin(angle) + p.y * Math.cos(angle) });
  const source = layout("room", (p) => ({ x: p.x * 2, y: p.y * 2 }));
  const rotated = { ...source, boundary: { outer: source.boundary.outer.map(transform) },
    rooms: source.rooms.map((r) => ({ ...r, polygon: { outer: r.polygon.outer.map(transform) } })),
    openings: source.openings.map((o) => ({ ...o, start: transform(o.start), end: transform(o.end) })) };
  for (let seed = 1; seed <= 10; seed++) {
    const props = planInteriorFurniture(source, seed, "education");
    const board = props.find((p) => p.kind === "whiteboard");
    assert.ok(board);
    const desks = props.filter((p) => p.kind === "student-desk");
    assert.equal(desks.length, 6);
    for (const desk of desks) assert.deepEqual(desk.inward, board.inward);
    const turned = planInteriorFurniture(rotated, seed, "education");
    assert.deepEqual(turned.map((p) => p.kind), props.map((p) => p.kind));
    props.forEach((p, i) => {
      const expected = transform(p.center);
      assert.ok(Math.hypot(expected.x - turned[i].center.x, expected.y - turned[i].center.y) < 1e-7);
    });
  }
});

test("hotel bathrooms retain sanitary fixtures and tiny specialty rooms omit furniture", () => {
  assert.deepEqual(planInteriorFurniture(layout("toilet"), 0, "hotel").map((p) => p.kind), ["toilet", "sink", "painting"]);
  for (const use of ["hotel", "education", "medical", "warehouse", "industrial", "garage"]) {
    assert.deepEqual(planInteriorFurniture(layout("room", (p) => ({ x: p.x / 10, y: p.y / 10 })), 12, use), []);
  }
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
