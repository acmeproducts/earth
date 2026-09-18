// Pixel-equivalence check for the cloud-shadow fast paths, on a real GPU.
import { Engine, Scene, UniversalCamera, Vector3, MeshBuilder, ShaderMaterial, DirectionalLight, ShadowGenerator } from '@babylonjs/core';
import { bindCloudShadowReceiver, cloudShadowFragmentDeclaration, CLOUD_SHADOW_UNIFORMS } from '../../src/sky/CloudShadows';
import { bindVegetationShadowReceiver, suspendVegetationShadowReceivers, resumeVegetationShadowReceivers } from '../../src/vegetation/VegetationShadowReceiver';
import { createCloudLayer } from '../../src/sky/Clouds';
import { createCloudField } from '../../src/sky/CloudField';
import type { SolarLighting, SolarLightingSnapshot } from '../../src/sky/SolarLighting';
import { setManualWindSpeed } from '../../src/vegetation/Wind';

void (async () => {
  const canvas = document.getElementById('renderCanvas') as HTMLCanvasElement;
  const engine = new Engine(canvas, false, { preserveDrawingBuffer:true });
  engine.setSize(128,128);
  const scene = new Scene(engine);
  const camera = new UniversalCamera('camera',new Vector3(0,0,-3),scene);
  camera.setTarget(Vector3.Zero());
  const mesh = MeshBuilder.CreatePlane('receiver',{size:3},scene);
  const vertexSource = `precision highp float;attribute vec3 position;uniform mat4 worldViewProjection;
    varying vec2 vCloudShadowWorldXZ;void main(){vCloudShadowWorldXZ=position.xy*80.0;
    gl_Position=worldViewProjection*vec4(position,1.0);}`;
  const legacy = cloudShadowFragmentDeclaration
    .replace('if (cloudField.y <= 0.0 || cloudField.w <= 0.0) return 1.0;','');
  const make = (name:string,declaration:string):ShaderMaterial => {
    const material=new ShaderMaterial(name,scene,{vertexSource,fragmentSource:
      `precision highp float;${declaration}\nvoid main(){gl_FragColor=vec4(vec3(vegetationCloudShadowVisibility()),1.0);}`},
    {attributes:['position'],uniforms:['worldViewProjection',...CLOUD_SHADOW_UNIFORMS],samplers:['cloudPattern']});
    bindCloudShadowReceiver(material,scene);
    return material;
  };
  const before=make('before',legacy), after=make('after',cloudShadowFragmentDeclaration);
  await Promise.all([before.forceCompilationAsync(mesh),after.forceCompilationAsync(mesh)]);
  const pixels=async(material:ShaderMaterial):Promise<Uint8Array>=>{
    mesh.material=material;
    engine.beginFrame();scene.render();engine.endFrame();
    return new Uint8Array((await engine.readPixels(0,0,128,128))!.buffer);
  };
  const results:object[]=[];
  const compare=async(name:string):Promise<void>=>{
    const a=await pixels(before),b=await pixels(after);
    let changed=0,maxDelta=0,min=255;
    for(let i=0;i<a.length;i++){const delta=Math.abs(a[i]-b[i]);if(delta)changed++;maxDelta=Math.max(maxDelta,delta);if(i%4!==3)min=Math.min(min,b[i]);}
    results.push({name,changed,maxDelta,min});
    if(maxDelta>1)throw new Error(`${name}: cloud fast path changed pixels by ${maxDelta}`);
    if(name==='daylight-cloud-field' && min>=250)throw new Error('Fixture did not render a visible cloud shadow');
  };
  await compare('clouds-disabled');
  const projector=createCloudField(scene,1,42);
  projector.parameters.y=1;
  projector.updateSun(Vector3.Up());
  await compare('daylight-cloud-field');
  projector.updateSun(new Vector3(0,-1,0));
  await compare('night');
  projector.updateSun(Vector3.Up());
  projector.offset.set(0.1,0.2);
  await compare('drifting-daylight');
  projector.parameters.y=0;
  await compare('empty-daylight');
  projector.dispose();
  await compare('projector-disposed');
  const sun=new DirectionalLight('sunLight',new Vector3(0,-1,0),scene);
  const generator=new ShadowGenerator(32,sun);
  let minDepth=1,maxDepth=9;
  sun.getDepthMinZ=()=>minDepth;sun.getDepthMaxZ=()=>maxDepth;
  const shadowReceiver=new ShaderMaterial('shadow-uniform-check',scene,{vertexSource,fragmentSource:
    `precision highp float;uniform float vegetationShadowEnabled;uniform vec2 vegetationShadowDepthValues;
    void main(){gl_FragColor=vec4(vegetationShadowEnabled,vegetationShadowDepthValues.x/10.0,vegetationShadowDepthValues.y/20.0,1.0);}`},
    {attributes:['position'],uniforms:['worldViewProjection','vegetationShadowEnabled','vegetationShadowDepthValues']});
  bindVegetationShadowReceiver(shadowReceiver,scene);
  await shadowReceiver.forceCompilationAsync(mesh);
  const checkUniforms=async(name:string,expected:number[]):Promise<void>=>{
    const data=await pixels(shadowReceiver);
    const actual=Array.from(data.slice((64*128+64)*4,(64*128+64)*4+4));
    if(actual.some((v,i)=>Math.abs(v-expected[i])>1))throw new Error(`${name}: expected ${expected}, got ${actual}`);
    results.push({name,actual,expected});
  };
  await checkUniforms('shadow-initial-uniforms',[255,26,128,255]);
  minDepth=2;maxDepth=10;
  await checkUniforms('shadow-mutated-shared-vector',[255,51,153,255]);
  scene.shadowsEnabled=false;
  await checkUniforms('shadow-disabled',[0,51,153,255]);
  scene.shadowsEnabled=true;
  await checkUniforms('shadow-reenabled',[255,51,153,255]);
  suspendVegetationShadowReceivers(scene,generator.getShadowMap()!);
  resumeVegetationShadowReceivers(scene);
  await checkUniforms('shadow-resumed',[255,51,153,255]);
  mesh.setEnabled(false);
  const lighting = { copyLightingTo(snapshot: SolarLightingSnapshot) {
    snapshot.sunDirection.set(0.7, 0.55, 0.4).normalize();
    snapshot.sunColor.set(1, 1, 1);
    snapshot.skyColor.set(0.8, 0.85, 1);
    snapshot.groundColor.set(0.3, 0.3, 0.3);
  } } as SolarLighting;
  setManualWindSpeed(0);
  const clouds = createCloudLayer(scene, lighting, {metersPerUnit:50,weatherSeed:42,density:0.6});
  const cloud = {x:0,z:0};
  camera.upVector.set(0,0,1);
  camera.maxZ=2000;
  const cloudPixels = async (offset:number,width:number,height:number):Promise<Uint8Array> => {
    camera.position.set(cloud.x+offset,0,cloud.z);
    camera.setTarget(camera.position.add(new Vector3(0,1,0)));
    clouds.update(camera.position);
    engine.setSize(width,height);
    scene.render();
    await scene.whenReadyAsync();
    engine.beginFrame();scene.render();engine.endFrame();
    return new Uint8Array((await engine.readPixels(0,0,width,height))!.buffer);
  };
  await (clouds.mesh.material as ShaderMaterial).forceCompilationAsync(clouds.mesh);
  const cloudScreenshots: Record<string,string> = {};
  for (const [width,height] of [[960,540],[390,844]]) {
    const beforePole=await cloudPixels(-0.0001,width,height);
    const afterPole=await cloudPixels(0.0001,width,height);
    cloudScreenshots[`clouds-${width}x${height}`]=canvas.toDataURL('image/png').split(',')[1];
    let totalDelta=0;
    for(let i=0;i<beforePole.length;i++)totalDelta+=Math.abs(beforePole[i]-afterPole[i]);
    const meanDelta=totalDelta/beforePole.length;
    if(meanDelta>0.1)throw new Error(`Cloud pole crossing shakes: ${meanDelta}`);
    clouds.setDensity(0);
    const empty=await cloudPixels(0,width,height);
    let cloudPixelsChanged=0;
    for(let i=0;i<empty.length;i+=4)if(Math.abs(empty[i]-afterPole[i])>5)cloudPixelsChanged++;
    if(cloudPixelsChanged<width*height*0.01)throw new Error('Cloud fixture is blank');
    clouds.setDensity(0.6);
    results.push({name:`cloud-pole-${width}x${height}`,meanDelta,cloudPixelsChanged});
  }
  const meanPixelDelta = (a:Uint8Array,b:Uint8Array):number => {
    let total=0;
    for(let i=0;i<a.length;i++)total+=Math.abs(a[i]-b[i]);
    return total/a.length;
  };
  // Repeated live updates and crossings of the former 8 km cell boundary.
  for(const center of [0,160,-160,640]) {
    let previous=await cloudPixels(center-0.2,480,270),maxDelta=0;
    for(let frame=0;frame<40;frame++) {
      const next=await cloudPixels(center-0.2+frame*0.01,480,270);
      maxDelta=Math.max(maxDelta,meanPixelDelta(previous,next));
      previous=next;
    }
    if(maxDelta>0.15)throw new Error(`Cloud travel jumps at ${center}: ${maxDelta}`);
    results.push({name:`cloud-travel-${center}`,maxDelta});
  }
  const still=await cloudPixels(0,480,270);
  for(let frame=0;frame<12;frame++) {
    const next=await cloudPixels(0,480,270);
    if(meanPixelDelta(still,next)>0.001)throw new Error('Stationary clouds changed shape');
  }
  setManualWindSpeed(30);
  let previous=still,maxWindDelta=0;
  for(let frame=0;frame<90;frame++) {
    await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
    const next=await cloudPixels(0,480,270);
    maxWindDelta=Math.max(maxWindDelta,meanPixelDelta(previous,next));
    previous=next;
  }
  const windMotion=meanPixelDelta(still,previous);
  if(windMotion<0.01 || maxWindDelta>0.3)throw new Error(`Wind motion: ${windMotion}, max jump: ${maxWindDelta}`);
  results.push({name:'cloud-wind-90-frames',windMotion,maxWindDelta});
  setManualWindSpeed(undefined);
  clouds.dispose();
  (window as any).pixelScreenshots=cloudScreenshots;
  (window as any).pixelResults=results;
  (window as any).pixelComplete=true;
})().catch(error=>{(window as any).pixelError=String(error?.stack??error);});
