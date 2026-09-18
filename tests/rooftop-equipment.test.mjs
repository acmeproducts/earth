import assert from "node:assert/strict";
import test from "node:test";
import { Color3, NullEngine, Ray, Scene, TransformNode, Vector3, VertexBuffer } from "@babylonjs/core";
import { findInteraction } from "../src/app/InteractionSystem.ts";
import { ProceduralBuildingRenderer } from "../src/procedural/ProceduralBuildingRenderer.ts";
import { planRoofAccess, planRooftopEquipment, createRooftopEquipment } from "../src/procedural/RooftopEquipment.ts";
import { distanceToRing, pointInRing } from "../src/core/PlanarGeometry.ts";

const rectangle = (x, z, width, depth) => [
  { x, z }, { x: x + width, z }, { x: x + width, z: z + depth }, { x, z: z + depth },
];
const plan = { detailSeed: 123, heightMeters: 36, minimumHeightMeters: 0, levels: 12 };
const outline = rectangle(0, 0, 40, 30);
const access = planRoofAccess({ start: { x: 10, z: 12 }, direction: { x: 1, z: 0 },
  inward: { x: 0, z: 1 }, widthMeters: 1.6, runMeters: 4.2, edgeIndex: 0 }, outline, [], 1).placement;

for (const scale of [1, 10]) test(`rooftop doors survive batching and clear the opening at scale ${scale}`, () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  engine.getDeltaTime = () => 16;
  try {
    const root = new TransformNode("tile", scene);
    root.position.set(15, 0, 20);
    const items = [0, 60].map((offset) => createRooftopEquipment(scene, plan,
      outline.map((p) => ({ x: (p.x + offset) / scale, z: p.z / scale })), [], 46, scale, Color3.White(),
      { ...access, x: access.x + offset }));
    const mesh = ProceduralBuildingRenderer.merge(items, "detailedBuildings", root);
    const doors = mesh.getChildMeshes().filter((child) => child.metadata?.buildingDoor);
    assert.equal(doors.length, 2);
    for (const door of doors) {
      scene.meshes.forEach((child) => child.computeWorldMatrix(true));
      const origin = Vector3.TransformCoordinates(new Vector3(0.45 / scale, 1 / scale, -1 / scale), door.getWorldMatrix());
      const direction = Vector3.TransformNormal(Vector3.Forward(), door.getWorldMatrix()).normalize();
      const ray = new Ray(origin, direction, 1.4 / scale);
      const action = findInteraction(scene, ray);
      assert.equal(action?.label, "Open door");
      assert.equal(scene.pickWithRay(ray, (child) => child === mesh)?.hit, false, "no solid wall behind the door");
      action.activate();
      for (let frame = 0; frame < 30; frame++) scene.onBeforeRenderObservable.notifyObservers(scene);
      scene.meshes.forEach((child) => child.computeWorldMatrix(true));
      assert.equal(findInteraction(scene, ray), undefined, "open door clears the doorway");
    }
    root.dispose(false, true);
    assert.equal(scene.meshes.length, 0);
  } finally {
    scene.dispose();
    engine.dispose();
  }
});

test("vent caps touch the shafts below them", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const mesh = createRooftopEquipment(scene, plan, outline, [], 46, 1, Color3.White());
    mesh.setEnabled(true);
    mesh.computeWorldMatrix(true);
    const vents = planRooftopEquipment(plan, outline).filter((item) => item.kind === "vent");
    assert.ok(vents.length);
    for (const vent of vents) {
      for (const offset of [-0.001, 0, 0.001]) {
        const ray = new Ray(new Vector3(vent.x, 46 + 0.16 + vent.height + offset, vent.z - 1), Vector3.Forward(), 2);
        assert.equal(scene.pickWithRay(ray, (child) => child === mesh)?.hit, true);
      }
    }
  } finally {
    scene.dispose();
    engine.dispose();
  }
});

test("tall roofs get varied, repeatable equipment and more units than low roofs", () => {
  const tall = planRooftopEquipment(plan, outline);
  assert.deepEqual(tall, planRooftopEquipment(plan, outline));
  assert.notDeepEqual(tall, planRooftopEquipment({ ...plan, detailSeed: 456 }, outline));
  for (const kind of ["ac", "vent"]) assert.ok(tall.some((item) => item.kind === kind));
  assert.ok(tall.every((item) => item.kind !== "access"), "access requires a stair connection");
  assert.deepEqual(planRooftopEquipment(plan, outline, [], access)[0], access);
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
        outline.map((p) => ({ x: p.x / scale, z: p.z / scale })), [], 46, scale, new Color3(0.6, 0.6, 0.6), access);
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
