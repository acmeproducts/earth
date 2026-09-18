import assert from "node:assert/strict";
import test from "node:test";
import { MeshBuilder, NullEngine, Ray, Scene, StandardMaterial, Vector3 } from "@babylonjs/core";
import { StaticMeshBatches } from "../src/rendering/StaticMeshBatches.ts";
import { meshSnowCover, setMeshSnowCover } from "../src/rendering/SnowCover.ts";

test("static batches preserve shader attributes, source terrain and collision queries", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const batches = new StaticMeshBatches(scene);
  try {
    const material = new StandardMaterial("shared", scene);
    const sources = [0, 4].map((x, index) => {
      const mesh = MeshBuilder.CreateGround(`tile ${index}`, { width: 2, height: 2 }, scene);
      mesh.position.x = x;
      mesh.material = material;
      mesh.checkCollisions = true;
      mesh.setVerticesData("snowMask", new Float32Array(mesh.getTotalVertices()).fill(index), false, 1);
      mesh.freezeWorldMatrix();
      batches.add(mesh, "region", 1);
      return mesh;
    });
    const original = sources.map(mesh => [...mesh.getVerticesData("position")]);
    batches.update();
    let batch = scene.meshes.find(mesh => mesh.name === "far static batch");
    assert.ok(batch);
    assert.equal(batch.material, material);
    assert.equal(batch.getTotalVertices(), 8);
    for (const mesh of [...sources, batch]) {
      assert.ok(mesh.getVerticesData("position") instanceof Float32Array,
        "Resident source and batch geometry must use packed vertex buffers");
      assert.ok(mesh.getIndices() instanceof Uint32Array,
        "Resident source and batch indices must stay packed");
    }
    assert.deepEqual([...batch.getVerticesData("snowMask")], [0, 0, 0, 0, 1, 1, 1, 1]);
    const positions = batch.getVerticesData("position");
    assert.equal(positions[12], original[1][0] + 4, "world translation is baked into the batch");
    assert.ok(sources.every(mesh => mesh.isEnabled() && !mesh.isVisible));
    assert.deepEqual(sources.map(mesh => [...mesh.getVerticesData("position")]), original);
    const picked = scene.pickWithRay(new Ray(new Vector3(0, 10, 0), new Vector3(0, -1, 0)),
      mesh => mesh.checkCollisions && mesh.isEnabled());
    assert.equal(picked.pickedMesh, sources[0]);
    batches.update();
    assert.equal(scene.meshes.length, 3, "stable batches are reused");
    const isEnabled = sources[0].isEnabled;
    sources[0].isEnabled = () => { throw new Error("Stable batch was revalidated"); };
    batches.update(false);
    sources[0].isEnabled = isEnabled;

    sources[0].visibility = .5;
    batches.update();
    assert.ok(batch.isDisposed());
    assert.ok(sources.every(mesh => mesh.isVisible));
    sources[0].visibility = 1;
    batches.update();
    batch = scene.meshes.find(mesh => mesh.name === "far static batch");
    assert.ok(batch);
    setMeshSnowCover(sources[0], .5, 1);
    batches.update();
    assert.ok(batch.isDisposed(), "different snow depths must not share a draw");
    setMeshSnowCover(sources[1], .5, 1);
    batches.update();
    batch = scene.meshes.find(mesh => mesh.name === "far static batch");
    assert.equal(meshSnowCover(batch), .5);
    sources[0].dispose();
    assert.ok(batch.isDisposed(), "unloading immediately removes stale batched geometry");
    assert.ok(sources[1].isVisible);
    assert.ok(scene.materials.includes(material));
    batches.update();
    assert.equal(scene.meshes.length, 1);
  } finally { batches.dispose(); scene.dispose(); engine.dispose(); }
});

test("batch updates upload at most one group and restore sources on disposal", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const batches = new StaticMeshBatches(scene);
  try {
    const material = new StandardMaterial("shared", scene);
    const sources = [];
    for (const region of ["a", "b"]) for (let i = 0; i < 2; i++) {
      const mesh = MeshBuilder.CreateBox(`${region}${i}`, {}, scene);
      mesh.material = material;
      sources.push(mesh);
      batches.add(mesh, region, 1);
    }
    batches.update();
    assert.equal(scene.meshes.length, 5);
    batches.update();
    assert.equal(scene.meshes.length, 6);
    sources[0].setEnabled(false);
    batches.update();
    assert.equal(scene.meshes.length, 5);
    sources[0].setEnabled(true);
    batches.update();
    assert.equal(scene.meshes.length, 6);
    batches.dispose();
    assert.equal(scene.meshes.length, 4);
    assert.ok(sources.every(mesh => mesh.isVisible));
  } finally { batches.dispose(); scene.dispose(); engine.dispose(); }
});
