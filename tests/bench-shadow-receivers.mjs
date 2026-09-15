// CPU-only comparison of the former per-material updater and the shared updater.
// yarn node --import ./tests/register-typescript.mjs tests/bench-shadow-receivers.mjs
import { performance } from 'node:perf_hooks';
import { NullEngine, Scene, UniversalCamera, Vector2, Vector3, DirectionalLight, ShadowGenerator, ShaderMaterial } from '@babylonjs/core';
import { bindVegetationShadowReceiver, isFloatShadowTexture } from '../src/vegetation/VegetationShadowReceiver.ts';

function create(shared, count) {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  new UniversalCamera('camera', Vector3.Zero(), scene);
  const sun = new DirectionalLight('sunLight', new Vector3(0,-1,0),scene);
  new ShadowGenerator(32,sun);
  for(let i=0;i<count;i++) {
    const material = new ShaderMaterial(`receiver-${i}`,scene,{},{});
    if(shared) bindVegetationShadowReceiver(material,scene);
    else scene.onBeforeRenderObservable.add(() => {
      // The former production update: lookups, transform and two allocations
      // repeated independently for every receiver, even inactive materials.
      const light=scene.lights.find(l=>l instanceof DirectionalLight && l.name==='sunLight');
      const generator=light?.getShadowGenerator(), camera=scene.activeCamera;
      if(!scene.shadowsEnabled || !light || !light.shadowEnabled || !(generator instanceof ShadowGenerator) || !camera || !light.isEnabled()) {
        material.setFloat('vegetationShadowEnabled',0); return;
      }
      const map=generator.getShadowMapForRendering();
      if(!map) {material.setFloat('vegetationShadowEnabled',0);return;}
      const size=map.getSize();
      material.setFloat('vegetationShadowEnabled',1);
      material.setFloat('vegetationShadowFloatTexture',isFloatShadowTexture(map.textureType)?1:0);
      material.setMatrix('vegetationShadowMatrix',generator.getTransformMatrix());
      material.setVector2('vegetationShadowTexelSize',new Vector2(1/Math.max(1,size.width),1/Math.max(1,size.height)));
      material.setVector2('vegetationShadowDepthValues',new Vector2(light.getDepthMinZ(camera),light.getDepthMinZ(camera)+light.getDepthMaxZ(camera)));
      material.setTexture('vegetationShadowSampler',map);
    });
  }
  return {tick:()=>scene.onBeforeRenderObservable.notifyObservers(scene),dispose:()=>{scene.dispose();engine.dispose();}};
}
for(const count of [100,400,1000]) {
  const old=create(false,count), current=create(true,count);
  for(let i=0;i<1000;i++){old.tick();current.tick();}
  const times={before:[],after:[]};
  for(let round=0;round<12;round++) {
    const order=round%2?[['after',current],['before',old]]:[['before',old],['after',current]];
    for(const [name,run] of order) {
      const start=performance.now();for(let i=0;i<1000;i++)run.tick();
      times[name].push((performance.now()-start)/1000);
    }
  }
  const median=a=>a.toSorted((a,b)=>a-b)[a.length>>1];
  console.log(JSON.stringify({receivers:count,beforeMs:median(times.before),afterMs:median(times.after),reductionPercent:100*(1-median(times.after)/median(times.before))}));
  old.dispose();current.dispose();
}
