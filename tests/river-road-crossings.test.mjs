import assert from 'node:assert/strict';
import test from 'node:test';
import { Mesh, NullEngine, Scene, VertexData } from '@babylonjs/core';
import { raiseRoadsAboveRivers } from '../src/roads/RiverRoadCrossings.ts';

function rectangle(minX, maxX, minZ, maxZ, height) {
  const data = new VertexData();
  data.positions = [minX, height, minZ, maxX, height, minZ,
    maxX, height, maxZ, minX, height, maxZ];
  data.indices = [0, 1, 2, 0, 2, 3];
  data.normals = new Array(4).fill([0, 1, 0]).flat();
  return data;
}

test('a narrow river crossing lifts the entire road triangle even with no road vertex in water', async () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const road = new Mesh('road', scene);
    rectangle(-20, 20, -2, 2, 5).applyToMesh(road);
    await raiseRoadsAboveRivers([road], [rectangle(-0.4, 0.4, -20, 20, 6)], 1);
    const positions = road.getVerticesData('position');
    for (let v = 0; v < 4; v++) assert.ok(positions[v * 3 + 1] >= 6.119);
    assert.ok(road.getBoundingInfo().maximum.y >= 6.119);
  } finally { scene.dispose(); engine.dispose(); }
});

test('existing high bridges and roads outside the river retain their geometry', async () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const bridge = new Mesh('bridge', scene);
    rectangle(-20, 20, -2, 2, 12).applyToMesh(bridge);
    const dry = new Mesh('dry', scene);
    rectangle(30, 40, -2, 2, 5).applyToMesh(dry);
    const before = [bridge, dry].map(mesh => [...mesh.getVerticesData('position')]);
    await raiseRoadsAboveRivers([bridge, dry], [rectangle(-1, 1, -20, 20, 6)], 1);
    for (const [i, mesh] of [bridge, dry].entries()) assert.deepEqual([...mesh.getVerticesData('position')], before[i]);
  } finally { scene.dispose(); engine.dispose(); }
});

test('crossing clearance scales with world units and is stable on repeated fitting', async () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const road = new Mesh('road', scene);
    rectangle(-2, 2, -0.2, 0.2, 0.5).applyToMesh(road);
    const river = rectangle(-0.04, 0.04, -2, 2, 0.6);
    await raiseRoadsAboveRivers([road], [river], 10);
    const before = [...road.getVerticesData('position')];
    assert.ok(Math.abs(before[1] - 0.612) < 1e-6);
    await raiseRoadsAboveRivers([road], [river], 10);
    assert.deepEqual([...road.getVerticesData('position')], before);
  } finally { scene.dispose(); engine.dispose(); }
});
