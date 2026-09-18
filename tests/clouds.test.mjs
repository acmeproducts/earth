import assert from 'node:assert/strict';
import test from 'node:test';
import { NullEngine, Scene, UniversalCamera, Vector3 } from '@babylonjs/core';
import { createCloudPattern, createCloudField, cloudFieldForScene } from '../src/sky/CloudField.ts';
import { createCloudLayer } from '../src/sky/Clouds.ts';

test('cloud texture is deterministic, varied, and continuous at repeat boundaries', () => {
  const size=256, pixels=createCloudPattern(42,size);
  assert.deepEqual(pixels,createCloudPattern(42,size));
  assert.notDeepEqual(pixels,createCloudPattern(43,size));
  const values=Array.from(pixels).filter((_,i)=>i%4===0);
  assert.ok(Math.max(...values)-Math.min(...values)>100);
  let maxSeam=0;
  for(let i=0;i<size;i++) {
    maxSeam=Math.max(maxSeam,Math.abs(pixels[i*size*4]-pixels[(i*size+size-1)*4]));
    maxSeam=Math.max(maxSeam,Math.abs(pixels[i*4]-pixels[((size-1)*size+i)*4]));
  }
  assert.ok(maxSeam<12,`repeat seam is ${maxSeam}/255`);
});

test('sun changes never regenerate textures, and disposed fields detach', () => {
  const engine=new NullEngine(),scene=new Scene(engine);
  const field=createCloudField(scene,50,42),texture=field.texture;
  field.parameters.y=0.6;
  for(let i=0;i<100;i++)field.updateSun(new Vector3(Math.sin(i),Math.cos(i),0));
  assert.equal(field.texture,texture);
  field.updateSun(new Vector3(0,-1,0));
  assert.equal(field.parameters.w,0);
  field.updateSun(Vector3.Up());
  assert.equal(field.parameters.w,1);
  const replacement=createCloudField(scene,50,43);
  field.dispose();
  assert.equal(cloudFieldForScene(scene),replacement);
  replacement.dispose();
  assert.equal(cloudFieldForScene(scene),undefined);
  scene.dispose();engine.dispose();
});

test('camera travel keeps one mesh, one texture, and fixed orientation', () => {
  const engine=new NullEngine(),scene=new Scene(engine);
  const camera=new UniversalCamera('camera',Vector3.Zero(),scene);
  const lighting={copyLightingTo(s) {
    s.sunDirection.set(0,1,0);s.sunColor.set(1,1,1);s.skyColor.set(0.8,0.8,0.8);
  }};
  const layer=createCloudLayer(scene,lighting,{metersPerUnit:50,weatherSeed:42,density:0.6});
  const positions=layer.mesh.getVerticesData('position').slice();
  const field=cloudFieldForScene(scene), texture=field.texture;
  for(let i=-100;i<=100;i++) {
    camera.position.set(i*160,0,i*77);
    layer.update(camera.position);
    assert.deepEqual(layer.mesh.rotation.asArray(),[0,0,0]);
    assert.deepEqual(layer.mesh.getVerticesData('position'),positions);
    assert.equal(field.texture,texture);
    assert.equal(scene.meshes.length,1);
  }
  layer.setDensity(0);
  assert.equal(layer.mesh.isEnabled(),false);
  assert.equal(field.parameters.y,0);
  layer.setDensity(1);
  assert.equal(layer.mesh.isEnabled(),true);
  assert.equal(field.parameters.y,1);
  layer.dispose();
  assert.equal(scene.meshes.length,0);
  assert.equal(scene.textures.length,0);
  scene.dispose();engine.dispose();
});
