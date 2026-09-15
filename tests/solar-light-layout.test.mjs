import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { NullEngine, Scene, DirectionalLight, HemisphericLight, Mesh, Vector3, ShadowGenerator } from '@babylonjs/core';
const hook=registerHooks({resolve(specifier,context,nextResolve){
  if(specifier==='./Moon'||specifier==='./StarField')return {url:`data:text/javascript,export class ${specifier.slice(2)} {}`,shortCircuit:true};
  return nextResolve(specifier,context);
},load(url,context,nextLoad){
  if(url.endsWith('.ts'))return {format:'module',shortCircuit:true,source:stripTypeScriptTypes(readFileSync(new URL(url),'utf8'),{mode:'transform'})};
  return nextLoad(url,context);
}});
const { SolarLighting }=await import('../src/sky/SolarLighting.ts');
hook.deregister();

test('Oslo clock changes preserve mesh light/sampler layout and extinguish sunlight at night',()=>{
  const engine=new NullEngine(),scene=new Scene(engine);
  try{
    const ambient=new HemisphericLight('skyAmbientLight',Vector3.Up(),scene);
    const sun=new DirectionalLight('sunLight',Vector3.Down(),scene);
    const shadow=new ShadowGenerator(32,sun);
    const rock=new Mesh('rock',scene);
    const lighting=Object.create(SolarLighting.prototype);
    Object.assign(lighting,{scene,latitude:59.905,longitude:10.735,calendarDate:'2026-09-05',
      directLight:sun,ambientLight:ambient,shadows:shadow,sunMesh:new Mesh('sun',scene),
      skyMaterial:{sunPosition:Vector3.Zero()},moon:{update(){}},starField:{update(){}},
      horizonMaterial:{setColor3(){}},lastAtmosphereUpdate:0,lastShadowUpdate:0});
    lighting.setTimeOfDay(14);
    const sources=rock.lightSources.map(light=>light.name);
    assert.equal(sources.length,2);
    assert.ok(sun.intensity>0);
    for(const hour of [22,7,12,22,14]){
      lighting.setTimeOfDay(hour);
      assert.deepEqual(rock.lightSources.map(light=>light.name),sources,`time ${hour} changed the compiled shadow sampler layout`);
      if(hour===22){assert.equal(sun.intensity,0);assert.equal(lighting.sunMesh.isEnabled(),false);}
    }
    assert.ok(sun.intensity>0);
  }finally{scene.dispose();engine.dispose();}
});
