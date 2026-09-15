import assert from 'node:assert/strict';
import test from 'node:test';
import { NullEngine, Scene, UniversalCamera, Vector3, DirectionalLight, ShadowGenerator, ShaderMaterial } from '@babylonjs/core';
import { bindVegetationShadowReceiver, suspendVegetationShadowReceivers, resumeVegetationShadowReceivers } from '../src/vegetation/VegetationShadowReceiver.ts';

test('hundreds of shadow receivers share one lookup and reuse uniform vectors', () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  new UniversalCamera('camera', Vector3.Zero(), scene);
  const sun = new DirectionalLight('sunLight', new Vector3(0,-1,0), scene);
  const generator = new ShadowGenerator(32, sun);
  let transforms = 0;
  const original = generator.getTransformMatrix.bind(generator);
  generator.getTransformMatrix = () => { transforms++; return original(); };
  const initialObservers = scene.onBeforeRenderObservable.observers.length;
  const materials = Array.from({length:400}, (_, i) => {
    const material = new ShaderMaterial(`receiver-${i}`, scene, {}, {});
    bindVegetationShadowReceiver(material, scene);
    return material;
  });
  assert.equal(scene.onBeforeRenderObservable.observers.length, initialObservers+1);
  transforms=0;
  scene.onBeforeRenderObservable.notifyObservers(scene);
  assert.equal(transforms,1);
  const texel = materials[0]._vectors2.vegetationShadowTexelSize;
  const depth = materials[0]._vectors2.vegetationShadowDepthValues;
  for(const material of materials) {
    assert.equal(material._floats.vegetationShadowEnabled,1);
    assert.equal(material._vectors2.vegetationShadowTexelSize,texel);
    assert.equal(material._vectors2.vegetationShadowDepthValues,depth);
  }
  scene.onBeforeRenderObservable.notifyObservers(scene);
  assert.equal(materials[0]._vectors2.vegetationShadowTexelSize,texel);
  assert.equal(materials[0]._vectors2.vegetationShadowDepthValues,depth);
  let uniformWrites=0;
  for(const material of materials) {
    for(const name of ['setFloat','setMatrix','setVector2','setTexture']) {
      const set=material[name].bind(material);
      material[name]=(...args)=>{uniformWrites++;return set(...args);};
    }
  }
  scene.onBeforeRenderObservable.notifyObservers(scene);
  assert.equal(uniformWrites,0,'unchanged sources need no per-material setter calls');
  sun.getDepthMinZ=()=>2;
  sun.getDepthMaxZ=()=>10;
  scene.onBeforeRenderObservable.notifyObservers(scene);
  assert.deepEqual(depth.asArray(),[2,12],'shared references still receive changed depth values');
  assert.equal(uniformWrites,0);
  materials[0].setFloat('vegetationShadowAtInstanceRoot',1);
  bindVegetationShadowReceiver(materials[0],scene);
  assert.equal(materials[0]._floats.vegetationShadowAtInstanceRoot,1);
  scene.shadowsEnabled=false;
  transforms=0;
  scene.onBeforeRenderObservable.notifyObservers(scene);
  assert.equal(transforms,0);
  assert.ok(materials.every(m=>m._floats.vegetationShadowEnabled===0));
  scene.shadowsEnabled=true;
  resumeVegetationShadowReceivers(scene);
  const map=generator.getShadowMapForRendering();
  suspendVegetationShadowReceivers(scene,map);
  assert.ok(materials.every(m=>m._floats.vegetationShadowEnabled===0 && m._textures.vegetationShadowSampler!==map));
  transforms=0;
  resumeVegetationShadowReceivers(scene);
  assert.equal(transforms,1);
  assert.ok(materials.every(m=>m._floats.vegetationShadowEnabled===1 && m._textures.vegetationShadowSampler===map));
  const replacementMatrix=original().clone();
  generator.getTransformMatrix=()=>replacementMatrix;
  scene.onBeforeRenderObservable.notifyObservers(scene);
  assert.ok(materials.every(m=>m._matrices.vegetationShadowMatrix===replacementMatrix));
  generator.getTransformMatrix=()=>{transforms++;return original();};
  for(const material of materials)material.dispose();
  // Observable removals are deferred, but removed callbacks cannot run again.
  transforms=0;
  scene.onBeforeRenderObservable.notifyObservers(scene);
  assert.equal(transforms,0);
  const replacement = new ShaderMaterial('replacement',scene,{},{});
  bindVegetationShadowReceiver(replacement,scene);
  transforms=0;
  scene.onBeforeRenderObservable.notifyObservers(scene);
  assert.equal(transforms,1);
  scene.dispose(); engine.dispose();
});
