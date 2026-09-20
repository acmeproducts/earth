import assert from "node:assert/strict";
import test from "node:test";
import { MeshBuilder, NullEngine, Scene, TransformNode, UniversalCamera, Vector3 } from "@babylonjs/core";
import { registerStaticMeshCandidates } from "../src/rendering/StaticMeshCandidates.ts";

test("static candidates follow camera turns, streamed additions, overrides and disposal", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const camera = new UniversalCamera("camera", Vector3.Zero(), scene);
    camera.minZ = .1;
    const box = (name, z) => {
      const mesh = MeshBuilder.CreateBox(name, {}, scene);
      mesh.position.z = z;
      return mesh;
    };
    const ahead = box("ahead", 10), behind = box("behind", -10);
    const dynamic = box("dynamic", -10);
    registerStaticMeshCandidates(scene, [ahead, behind]);
    const candidates = () => {
      scene.render();
      const result = scene.getActiveMeshCandidates();
      return result.data.slice(0, result.length);
    };
    assert.deepEqual(new Set(candidates()), new Set([ahead, dynamic]));
    dynamic.setEnabled(false);
    assert.ok(!candidates().includes(dynamic), "staged geometry skips active-mesh evaluation");
    dynamic.setEnabled(true);
    assert.ok(candidates().includes(dynamic), "committed geometry returns without registration");
    const stagingRoot = new TransformNode("staging", scene);
    stagingRoot.setEnabled(false);
    dynamic.parent = stagingRoot;
    let matrixUpdates = 0;
    const computeWorldMatrix = dynamic.computeWorldMatrix.bind(dynamic);
    dynamic.computeWorldMatrix = (...args) => { matrixUpdates++; return computeWorldMatrix(...args); };
    assert.ok(!candidates().includes(dynamic), "disabled ancestors also hide staged parts");
    assert.equal(matrixUpdates, 0, "rendering does not update disabled geometry bounds");
    dynamic.parent = null;
    assert.ok(candidates().includes(dynamic));
    let tests = 0;
    const originalTest = behind.isInFrustum.bind(behind);
    behind.isInFrustum = (...args) => { tests++; return originalTest(...args); };
    scene.getActiveMeshCandidates();
    scene.getActiveMeshCandidates();
    assert.equal(tests, 0, "an unchanged camera reuses static frustum results");
    assert.equal(ahead.isWorldMatrixFrozen, true);
    camera.rotation.y = Math.PI;
    assert.deepEqual(new Set(candidates()), new Set([behind, dynamic]));
    assert.ok(tests > 0, "camera turns invalidate cached culling");
    behind.unfreezeWorldMatrix();
    behind.position.x = 1000;
    behind.freezeWorldMatrix();
    assert.ok(!candidates().includes(behind), "a changed static world matrix invalidates cached bounds");
    const streamed = box("streamed", -20);
    registerStaticMeshCandidates(scene, [streamed]);
    assert.ok(candidates().includes(streamed));
    ahead.alwaysSelectAsActiveMesh = true;
    assert.ok(candidates().includes(ahead));
    ahead.alwaysSelectAsActiveMesh = false;
    scene.skipFrustumClipping = true;
    assert.ok(candidates().includes(ahead));
    scene.skipFrustumClipping = false;
    behind.dispose();
    assert.ok(!candidates().includes(behind));
    assert.ok(candidates().includes(dynamic), "dynamic meshes retain Babylon's normal evaluation");
  } finally {
    scene.dispose();
    engine.dispose();
  }
});
