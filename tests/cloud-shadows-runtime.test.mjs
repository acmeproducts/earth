import assert from "node:assert/strict";
import test from "node:test";
import { NullEngine, Scene, ShaderMaterial, Vector3 } from "@babylonjs/core";

const { createCloudShadowProjector, bindCloudShadowReceiver, cloudShadowFragmentDeclaration } = await import("../src/sky/CloudShadows.ts");
const { cloudPlacementsAround } = await import("../src/sky/CloudDistribution.ts");
const { createTerrainMaterial } = await import("../src/terrain/TerrainMaterial.ts");

test("nearest cloud footprints bind directly to the terrain receiver", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const projector = createCloudShadowProjector(scene, 50);
  const terrainMaterial = createTerrainMaterial(scene, { usesLandCoverTint: true });
  const placements = cloudPlacementsAround(0, 0, 18_000, 50, 42);

  projector.upload(placements);
  projector.setDrift(2, -1);
  projector.update(Vector3.Zero(), new Vector3(0.3, 0.8, 0.2).normalize());

  assert.equal(terrainMaterial.constructor.name, "CustomMaterial");
  const nearest = terrainMaterial._newUniformInstances["vec4-cloudShadowPlacement0"];
  assert.ok(nearest.z > 0);
  assert.ok(nearest.w > 0);
  assert.equal(scene.customRenderTargets.length, 0);

  projector.dispose();
  assert.equal(nearest.z, 0);
  assert.equal(nearest.w, 0);
  scene.dispose();
  engine.dispose();
});

test("zero-strength cloud shadows skip samples and recover on daylight updates", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const receiver = new ShaderMaterial('cloud-receiver',scene,{},{});
  bindCloudShadowReceiver(receiver,scene);
  const lighting=receiver._vectors4.cloudShadowLighting;
  assert.equal(lighting.x,0,'disabled clouds take the zero-contribution path');
  const projector=createCloudShadowProjector(scene,50);
  const terrain=createTerrainMaterial(scene,{usesLandCoverTint:true});
  projector.upload(cloudPlacementsAround(0,0,18000,50,42));
  projector.update(Vector3.Zero(),Vector3.Up());
  assert.equal(receiver._vectors4.cloudShadowLighting,lighting);
  assert.ok(lighting.x>0,'daylight enables the original sampling path');
  projector.update(Vector3.Zero(),new Vector3(0,-1,0));
  assert.equal(lighting.x,0,'night skips sampling');
  projector.update(Vector3.Zero(),Vector3.Up());
  assert.ok(lighting.x>0);
  projector.dispose();
  assert.equal(lighting.x,0);
  for(let i=0;i<4;i++)assert.equal(receiver._vectors4[`cloudShadowPlacement${i}`].z,0);
  assert.match(cloudShadowFragmentDeclaration,/if \(cloudShadowLighting\.x == 0\.0\) return 1\.0;[\s\S]*float coverage/);
  assert.match(cloudShadowFragmentDeclaration,/if \(min\(placement\.z, placement\.w\) < 0\.000001\) return 0\.0;[\s\S]*texture2D/);
  assert.match(terrain.CustomParts.Fragment_Before_Fog,/if \(cloudShadowLighting\.x != 0\.0\) \{/);
  assert.match(terrain.CustomParts.Fragment_Definitions,/if \(min\(placement\.z, placement\.w\) < 0\.000001\) return 0\.0;/);
  scene.dispose();engine.dispose();
});

test("combined drift and lighting update matches separate updates with one selection", () => {
  const engine=new NullEngine(), scene=new Scene(engine);
  const projector=createCloudShadowProjector(scene,50);
  const receiver=new ShaderMaterial('receiver',scene,{},{});
  bindCloudShadowReceiver(receiver,scene);
  const placements=cloudPlacementsAround(0,0,18000,50,42);
  projector.upload(placements);
  const camera=new Vector3(4,0,8), sun=new Vector3(0.3,0.8,0.2).normalize();
  const snapshot=()=>Array.from({length:4},(_,i)=>[
    ...receiver._vectors4[`cloudShadowPlacement${i}`].asArray(),
    ...receiver._vectors2[`cloudShadowMetadata${i}`].asArray(),
  ]);
  projector.setDrift(2,-1);projector.update(camera,sun);
  const separate=snapshot();
  projector.update(Vector3.Zero(),Vector3.Up(),0,0);
  let visits=0;
  const counted=placements.map(p=>({...p,get x(){visits++;return p.x;}}));
  projector.upload(counted);
  visits=0;
  projector.update(camera,sun,2,-1);
  assert.deepEqual(snapshot(),separate);
  assert.equal(visits,placements.length,'one traversal of candidate clouds, not two');
  projector.dispose();scene.dispose();engine.dispose();
});
