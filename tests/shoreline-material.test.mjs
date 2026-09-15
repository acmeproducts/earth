import assert from 'node:assert/strict';
import test from 'node:test';
import { Mesh, MeshBuilder, NullEngine, Scene, VertexBuffer } from '@babylonjs/core';
import { attachShoreline } from '../src/water/Shoreline.ts';
import { createWaterPlane, disposeWaterPlane } from '../src/water/Water.ts';
import { createTerrainLakeLayer, disposeTerrainLakeLayer } from '../src/terrain/TerrainLakeSurface.ts';

test('coastal tiles share one material and release their own geometry', async () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const positions = [-30, -3, 0, 30, 3, 0, 0, 0, 30];
    const first = new Mesh('first', scene);
    const second = new Mesh('second', scene);
    const a = await attachShoreline(first, positions, [0, 1, 2], 1);
    const b = await attachShoreline(second, positions, [0, 1, 2], 1);
    assert.ok(a && b);
    assert.equal(a.material, b.material);
    assert.ok(a.material.getActiveTextures().length >= 2);
    assert.equal(a.material.disableDepthWrite, false);
    const sea = createWaterPlane(scene, { metersPerUnit: 1 });
    assert.equal(sea.material, a.material, 'shore and sea must use the exact same material instance');
    disposeWaterPlane(sea);
    assert.ok(a.getLODLevels()[0].distanceOrScreenCoverage >= 360);
    const material = b.material;
    first.dispose(false, false);
    assert.equal(a.isDisposed(), true);
    assert.equal(b.isDisposed(), false);
    assert.ok(scene.materials.includes(material));
    assert.equal(b.material, material);
    second.dispose(false, false);
    assert.equal(scene.materials.includes(material), false);
  } finally {
    scene.dispose();
    engine.dispose();
  }
});

test('lake and ocean use the same shader with different motion parameters', () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const sea = createWaterPlane(scene, { kind: 'ocean' });
    const lake = createWaterPlane(scene, { kind: 'lake' });
    assert.equal(sea.material.getClassName(), lake.material.getClassName());
    const seaMotion = sea.material.pluginManager.getPlugin('WaterMotion');
    const lakeMotion = lake.material.pluginManager.getPlugin('WaterMotion');
    assert.equal(seaMotion.constructor, lakeMotion.constructor);
    assert.ok(lakeMotion.profile.heaveMeters < seaMotion.profile.heaveMeters);
    assert.ok(lakeMotion.profile.foamStrength < seaMotion.profile.foamStrength);
    assert.ok(sea.getBoundingInfo().maximum.y >= seaMotion.profile.heaveMeters + seaMotion.profile.crestMeters);
  } finally { scene.dispose(); engine.dispose(); }
});

test('an inland tile allocates no shoreline mesh or material', async () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const ground = new Mesh('inland', scene);
    const count = scene.materials.length;
    assert.equal(await attachShoreline(ground, [0, 20, 0, 10, 20, 0, 0, 20, 10], [0, 1, 2], 1), null);
    assert.equal(scene.meshes.length, 1);
    assert.equal(scene.materials.length, count);
  } finally {
    scene.dispose();
    engine.dispose();
  }
});

test('lake shores use their lake level and survive replacement of the terrain mesh', async () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const ground = MeshBuilder.CreateGround('lake-bed', { width: 40, height: 40, subdivisions: 8, updatable: true }, scene);
    const positions = ground.getVerticesData(VertexBuffer.PositionKind);
    for (let i = 0; i < positions.length; i += 3) positions[i + 1] = 5 + positions[i] * 0.1;
    ground.updateVerticesData(VertexBuffer.PositionKind, positions, true);
    const lake = await createTerrainLakeLayer(scene, [{
      sourceId: 'lake', elevationMeters: 5, holes: [],
      outline: [{x:-20,z:-20}, {x:0,z:-20}, {x:0,z:20}, {x:-20,z:20}],
    }], { meshWidth: 40, meshDepth: 40, metersPerUnit: 1, terrain: ground });
    const shore = lake.meshes.find(mesh => mesh.name.endsWith(' shoreline'));
    assert.ok(shore);
    assert.equal(shore.parent, lake.root);
    assert.equal(shore.material, lake.meshes[0].material);
    assert.ok(Math.abs(shore.getVerticesData(VertexBuffer.PositionKind)[1] - 5.35) < 1e-6);
    const material = shore.material;
    ground.dispose();
    assert.equal(shore.isDisposed(), false);
    disposeTerrainLakeLayer(lake);
    assert.equal(shore.isDisposed(), true);
    assert.equal(scene.materials.includes(material), false);
  } finally { scene.dispose(); engine.dispose(); }
});
