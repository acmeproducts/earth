import assert from "node:assert/strict";
import test from "node:test";
import { Color3, NullEngine, Scene, VertexBuffer } from "@babylonjs/core";
import { planRooftopEquipment, createRooftopEquipment } from "../src/procedural/RooftopEquipment.ts";
import { distanceToRing, pointInRing } from "../src/core/PlanarGeometry.ts";

const rectangle = (x, z, width, depth) => [
  { x, z }, { x: x + width, z }, { x: x + width, z: z + depth }, { x, z: z + depth },
];
const plan = { detailSeed: 123, heightMeters: 36, minimumHeightMeters: 0, levels: 12 };
const outline = rectangle(0, 0, 40, 30);

test("tall roofs get varied, repeatable equipment and more units than low roofs", () => {
  const tall = planRooftopEquipment(plan, outline);
  assert.deepEqual(tall, planRooftopEquipment(plan, outline));
  assert.notDeepEqual(tall, planRooftopEquipment({ ...plan, detailSeed: 456 }, outline));
  for (const kind of ["access", "ac", "vent"]) assert.ok(tall.some((item) => item.kind === kind));
  assert.ok(tall.length > planRooftopEquipment({ ...plan, heightMeters: 3.1, levels: 1 }, outline).length);
});

test("equipment stays clear of concave roof edges, courtyards and other units", () => {
  const concave = [{ x: 0, z: 0 }, { x: 40, z: 0 }, { x: 40, z: 14 },
    { x: 20, z: 14 }, { x: 20, z: 30 }, { x: 0, z: 30 }];
  const hole = rectangle(6, 6, 6, 6);
  for (let seed = 0; seed < 20; seed++) {
    const items = planRooftopEquipment({ ...plan, detailSeed: seed }, concave, [hole]);
    assert.ok(items.length > 0);
    for (const [index, item] of items.entries()) {
      const radius = Math.hypot(item.width, item.depth) / 2;
      assert.ok(pointInRing(item, concave));
      assert.ok(!pointInRing(item, hole));
      assert.ok(distanceToRing(item, concave) >= radius + 0.95);
      assert.ok(distanceToRing(item, hole) >= radius + 0.95);
      for (const other of items.slice(index + 1)) {
        assert.ok(Math.hypot(item.x - other.x, item.z - other.z) > radius + Math.hypot(other.width, other.depth) / 2);
      }
    }
  }
  assert.deepEqual(planRooftopEquipment(plan, rectangle(0, 0, 2, 50)), []);
});

test("equipment geometry sits on the roof and scales with scene units", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const vertices = (scale) => {
      const mesh = createRooftopEquipment(scene, plan,
        outline.map((p) => ({ x: p.x / scale, z: p.z / scale })), [], 46, scale, new Color3(0.6, 0.6, 0.6));
      assert.ok(mesh);
      assert.equal(mesh.isEnabled(), false);
      const positions = Array.from(mesh.getVerticesData(VertexBuffer.PositionKind), (value) => value * scale);
      assert.ok(positions.every(Number.isFinite));
      const heights = positions.filter((_, index) => index % 3 === 1);
      assert.ok(Math.min(...heights) >= 46 - 1e-5);
      assert.ok(Math.max(...heights) > 48.5);
      mesh.dispose();
      return positions;
    };
    const unit = vertices(1), scaled = vertices(10);
    assert.equal(unit.length, scaled.length);
    unit.forEach((value, index) => assert.ok(Math.abs(value - scaled[index]) < 1e-4));
    assert.equal(scene.meshes.length, 0);
  } finally {
    scene.dispose();
    engine.dispose();
  }
});
