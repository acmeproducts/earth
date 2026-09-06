// Pixel-equivalence check for the cloud-shadow fast paths, on a real GPU.
import { Engine, Scene, UniversalCamera, Vector3, MeshBuilder, ShaderMaterial, DirectionalLight, ShadowGenerator } from '@babylonjs/core';
import { bindCloudShadowReceiver, createCloudShadowProjector, cloudShadowFragmentDeclaration, CLOUD_SHADOW_UNIFORMS } from '../../src/CloudShadows';
import { bindVegetationShadowReceiver, suspendVegetationShadowReceivers, resumeVegetationShadowReceivers } from '../../src/VegetationShadowReceiver';

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
    .replace('if (min(placement.z, placement.w) < 0.000001) return 0.0;','')
    .replace('if (cloudShadowLighting.x == 0.0) return 1.0;','');
  const make = (name:string,declaration:string):ShaderMaterial => {
    const material=new ShaderMaterial(name,scene,{vertexSource,fragmentSource:
      `precision highp float;${declaration}\nvoid main(){gl_FragColor=vec4(vec3(vegetationCloudShadowVisibility()),1.0);}`},
    {attributes:['position'],uniforms:['worldViewProjection',...CLOUD_SHADOW_UNIFORMS],samplers:['cloudShadowAtlas']});
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
    if(name==='daylight-one-cloud-three-empty-slots' && min>=250)throw new Error('Fixture did not render a visible cloud shadow');
  };
  await compare('clouds-disabled');
  const projector=createCloudShadowProjector(scene,1);
  projector.upload([{x:0,y:20,z:0,width:200,height:30,depth:200,variant:0,mirrored:false}]);
  projector.update(Vector3.Zero(),Vector3.Up());
  await compare('daylight-one-cloud-three-empty-slots');
  projector.update(Vector3.Zero(),new Vector3(0,-1,0));
  await compare('night');
  projector.update(Vector3.Zero(),Vector3.Up(),20,30);
  await compare('drifting-daylight');
  projector.upload([]);
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
  (window as any).pixelResults=results;
  (window as any).pixelComplete=true;
})().catch(error=>{(window as any).pixelError=String(error?.stack??error);});
