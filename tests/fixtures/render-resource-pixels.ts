import { Engine, Scene, UniversalCamera, Vector3, Color4, MeshBuilder,
  StandardMaterial, RawTexture, Texture, DirectionalLight, HemisphericLight, Matrix,
  ShadowGenerator, RenderTargetTexture, TransformNode, SSRRenderingPipeline, Constants } from '@babylonjs/core';
import { createImpostorPrototypeFromAssets } from '../../src/vegetation/TreeField';
import { suspendVegetationShadowReceivers, resumeVegetationShadowReceivers } from '../../src/vegetation/VegetationShadowReceiver';
import { captureImpostorAtlases, type ImpostorAssets } from '../../src/rendering/Impostor';
import { monitorRenderHealth } from '../../src/diagnostics/RenderHealth';
import { createWaterSurfaceMaterial, bindWaterMaterial } from '../../src/water/Water';
import { setManualWindSpeed } from '../../src/vegetation/Wind';
import { SolarLighting } from '../../src/sky/SolarLighting';

const probe = window as any;
void (async () => {
  const engine = new Engine(document.getElementById('renderCanvas') as HTMLCanvasElement, false, {preserveDrawingBuffer:true});
  engine.setSize(192,128);
  const scene = new Scene(engine);
  monitorRenderHealth(scene);
  scene.clearColor = new Color4(0.1,0.2,0.3,1);
  const camera = new UniversalCamera('eye',new Vector3(0,2,-8),scene);
  camera.setTarget(new Vector3(0,1,0));
  const ambient=new HemisphericLight('skyAmbientLight',Vector3.Up(),scene);
  const sun = new DirectionalLight('sunLight',new Vector3(0.3,-1,0.2),scene);
  sun.position.set(0,10,-5);
  sun.autoCalcShadowZBounds=true;
  sun.autoUpdateExtends=true;
  const shadow = new ShadowGenerator(128,sun);
  shadow.useContactHardeningShadow = true;
  const map = shadow.getShadowMap()!;
  map.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONCE;
  map.onBeforeBindObservable.add(()=>suspendVegetationShadowReceivers(scene,map));
  map.onAfterUnbindObservable.add(()=>resumeVegetationShadowReceivers(scene));
  const solar:any=Object.create(SolarLighting.prototype);
  Object.assign(solar,{scene,latitude:59.905,longitude:10.735,calendarDate:'2026-09-05',
    directLight:sun,ambientLight:ambient,shadows:shadow,
    sunMesh:MeshBuilder.CreateSphere('sun marker',{diameter:0.01},scene),
    skyMaterial:{sunPosition:Vector3.Zero()},moon:{update(){}},starField:{update(){}},
    horizonMaterial:{setColor3(){}},lastAtmosphereUpdate:0,lastShadowUpdate:0});
  solar.setTimeOfDay(14);
  const atlas=()=>RawTexture.CreateRGBATexture(new Uint8Array([30,180,40,255]),1,1,scene,false,false,Texture.NEAREST_SAMPLINGMODE);
  const assets: ImpostorAssets = {textures:Array.from({length:5},atlas),lowResolutionTextures:Array.from({length:5},atlas),atlasCanvases:[],
    rotationallySymmetric:true,rotationalSymmetryOrder:0,upperHemisphereOnly:false,gridWidth:1,gridHeight:1,gridSize:1,
    resolution:1,resolutionWidth:1,resolutionHeight:1,lowResolutionWidth:1,lowResolutionHeight:1,
    sourceHeight:2,captureDiameter:2,captureWidth:2,captureHeight:2};
  const root = new TransformNode('live field',scene);
  const vegetation = createImpostorPrototypeFromAssets(scene,assets,2,root,'live vegetation');
  vegetation.mesh.position.x=-1.5;
  shadow.addShadowCaster(vegetation.mesh);
  const water = MeshBuilder.CreateGround('water',{width:3,height:4},scene);
  water.position.x=1.5;
  setManualWindSpeed(0);
  const waterMaterial = createWaterSurfaceMaterial(scene,{width:3,height:4,metersPerUnit:1});
  const oldBump=waterMaterial.bumpTexture;
  waterMaterial.bumpTexture=RawTexture.CreateRGBATexture(new Uint8Array([128,128,255,255]),1,1,scene);
  oldBump?.dispose();
  bindWaterMaterial(water,waterMaterial,1,'ocean');
  water.receiveShadows=true;
  const rock=MeshBuilder.CreateBox('rock',{},scene);
  rock.thinInstanceSetBuffer('matrix',new Float32Array(Matrix.Translation(2,0.5,0).asArray()),16);
  const rockMaterial=new StandardMaterial('rock material',scene);
  rockMaterial.bumpTexture=waterMaterial.bumpTexture;
  rockMaterial.detailMap.isEnabled=true;
  rockMaterial.detailMap.texture=waterMaterial.bumpTexture;
  rock.material=rockMaterial;rock.receiveShadows=true;
  shadow.addShadowCaster(rock);
  const ssr = new SSRRenderingPipeline('ssr',scene,[camera],false,Constants.TEXTURETYPE_UNSIGNED_BYTE);
  ssr.samples=4;
  const exclude=(target:any)=>{if(target instanceof RenderTargetTexture)target.noPrePassRenderer=true;};
  scene.textures.forEach(exclude);
  scene.onNewTextureAddedObservable.add(exclude);
  const render=async()=>{
    for(let i=0;i<3;i++){engine.beginFrame();scene.render();engine.endFrame();await new Promise(requestAnimationFrame);}
    const data=await engine.readPixels(0,0,192,128);
    let green=0,blue=0;
    for(let i=0;i<data.length;i+=4){if(data[i+1]>data[i]*1.5&&data[i+1]>data[i+2]*1.5)green++;if(data[i+2]>data[i]*1.5)blue++;}
    return {green,blue,glError:engine._gl.getError()};
  };
  await scene.whenReadyAsync();
  const results:any[]=[];
  const baseline=await render();results.push({phase:'baseline',...baseline});
  if(baseline.green<50)throw new Error(`No visible vegetation: ${JSON.stringify(baseline)}`);
  const lightLayout=rock.lightSources.map(light=>light.name).join(',');
  for(const hour of [14,22,7,12,22,14]){
    solar.setTimeOfDay(hour);scene.render();
    if(rock.lightSources.map(light=>light.name).join(',')!==lightLayout)throw new Error('Clock change invalidated the shadow sampler layout');
    const error=engine._gl.getError();
    if(error)throw new Error(`Rapid clock changes generated WebGL error ${error}`);
  }
  for(let i=0;i<20;i++){
    solar.setTimeOfDay(i%2===0?14:22);map.resetRefreshCounter();
    const temporary=new TransformNode('retiring field',scene);
    const plant=createImpostorPrototypeFromAssets(scene,assets,2,temporary,'retiring vegetation');
    plant.mesh.position.x=50;
    const transition=await render();
    if(transition.glError)throw new Error(`Clock transition generated WebGL error ${transition.glError} at phase ${i}`);
    temporary.dispose(false,false);
    if(i%5===0){
      const source=MeshBuilder.CreateBox('capture source',{},scene);
      const material=new StandardMaterial('capture material',scene);source.material=material;
      const capture=await captureImpostorAtlases(scene,{name:'regressionCapture',meshes:[source],gridWidth:1,gridHeight:1,resolution:16,sourceHeight:1,captureDiameter:2,cooperative:true});
      source.dispose(false,true);
      capture.textures.forEach(t=>t.dispose());capture.lowResolutionTextures.forEach(t=>t.dispose());
    }
    solar.setTimeOfDay(14);map.resetRefreshCounter();
    const state=await render();results.push({phase:i,...state});
    if(state.green<baseline.green*0.8||state.glError)throw new Error(`Render corruption: ${JSON.stringify(results)}`);
  }
  map.renderList=[];
  sun.forceProjectionMatrixCompute();map.resetRefreshCounter();
  const empty=await render();results.push({phase:'empty-casters',...empty});
  shadow.addShadowCaster(vegetation.mesh);
  sun.forceProjectionMatrixCompute();map.resetRefreshCounter();
  const reloaded=await render();results.push({phase:'reloaded-casters',...reloaded});
  if(reloaded.green<baseline.green*0.8||reloaded.glError)throw new Error(`Caster reload lost vegetation: ${JSON.stringify(results)}`);
  const extension=engine._gl.getExtension('WEBGL_lose_context');
  if(!extension)throw new Error('Context loss extension unavailable');
  const restored=new Promise<void>(resolve=>engine.onContextRestoredObservable.addOnce(()=>resolve()));
  const lost=new Promise<void>(resolve=>engine.onContextLostObservable.addOnce(()=>resolve()));
  extension.loseContext();await lost;await new Promise(resolve=>setTimeout(resolve,100));
  extension.restoreContext();await restored;
  const recovered=await render();results.push({phase:'context-restored',...recovered});
  if(recovered.green<baseline.green*0.8||recovered.glError)throw new Error(`Context restoration lost vegetation: ${JSON.stringify(results)}`);
  probe.pixelResults=results;probe.pixelComplete=true;
})().catch(error=>{probe.pixelError=String(error?.stack??error);});
