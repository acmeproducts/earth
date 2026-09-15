import assert from "node:assert/strict";
import test from "node:test";
import {
  Color3,
  Mesh,
  NullEngine,
  Scene,
  ShaderMaterial,
  StandardMaterial,
} from "@babylonjs/core";
import { configureVegetationMaterials } from "../src/vegetation/VegetationMaterial.ts";

function recordingShaderMaterial(scene, name) {
  const material = new ShaderMaterial(
    name,
    scene,
    { vertexSource: "void main(void) { gl_Position = vec4(0.0); }", fragmentSource: "void main(void) { gl_FragColor = vec4(1.0); }" },
    { attributes: ["position"], uniforms: [] },
  );
  const floats = new Map();
  const colors = new Map();
  material.setFloat = (uniform, value) => {
    floats.set(uniform, value);
    return material;
  };
  material.setColor3 = (uniform, value) => {
    colors.set(uniform, value);
    return material;
  };
  return { material, floats, colors };
}

test("applies shared vegetation settings to every shader renderer", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const impostor = new Mesh("impostor", scene);
  const model = new Mesh("model", scene);
  const ignored = new Mesh("ignored", scene);
  const impostorRecording = recordingShaderMaterial(scene, "impostorMaterial");
  const modelRecording = recordingShaderMaterial(scene, "modelMaterial");
  impostor.material = impostorRecording.material;
  model.material = modelRecording.material;
  ignored.material = new StandardMaterial("standardMaterial", scene);
  const groundColor = new Color3(0.12, 0.25, 0.09);

  configureVegetationMaterials([impostor, model, ignored], {
    floats: { groundColorBlend: 0.14, vegetationShadowDarkness: 0.3 },
    colors: { distanceGroundColor: groundColor },
  });

  for (const recording of [impostorRecording, modelRecording]) {
    assert.deepEqual(
      Object.fromEntries(recording.floats),
      { groundColorBlend: 0.14, vegetationShadowDarkness: 0.3 },
    );
    assert.equal(recording.colors.get("distanceGroundColor"), groundColor);
  }
  scene.dispose();
  engine.dispose();
});

test("can apply impostor-only settings without changing the model", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const impostor = new Mesh("impostor", scene);
  const model = new Mesh("model", scene);
  const impostorRecording = recordingShaderMaterial(scene, "impostorMaterial");
  const modelRecording = recordingShaderMaterial(scene, "modelMaterial");
  impostor.material = impostorRecording.material;
  model.material = modelRecording.material;

  configureVegetationMaterials([impostor], {
    floats: { impostorLodNear: 20, impostorLodFar: 50 },
  });

  assert.deepEqual(
    Object.fromEntries(impostorRecording.floats),
    { impostorLodNear: 20, impostorLodFar: 50 },
  );
  assert.equal(modelRecording.floats.size, 0);
  scene.dispose();
  engine.dispose();
});
