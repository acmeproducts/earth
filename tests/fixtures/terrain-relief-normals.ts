import { Engine, Scene, UniversalCamera, Vector3, MeshBuilder, DirectionalLight, Color3, VertexBuffer } from '@babylonjs/core';
import { createTerrainMaterial } from '../../src/terrain/TerrainMaterial';
import { attachTerrainReliefNormals } from '../../src/terrain/TerrainReliefNormals';
import { createCloudShadowProjector } from '../../src/sky/CloudShadows';
import type { TerrainData } from '../../src/terrain/TerrainData';

const probe = window as any;
void (async () => {
  const engine = new Engine(document.getElementById('renderCanvas') as HTMLCanvasElement, false, {preserveDrawingBuffer: true});
  engine.setSize(128, 128);
  const scene = new Scene(engine);
  const camera = new UniversalCamera('eye', new Vector3(0, 12, 0), scene);
  camera.setTarget(Vector3.Zero());
  const sun = new DirectionalLight('sun', new Vector3(0.7, -1, 0.2), scene);
  sun.intensity = 1;
  // Exercise composition with the cloud CustomMaterial as used by the app.
  createCloudShadowProjector(scene, 1);
  const material = createTerrainMaterial(scene);
  material.diffuseColor = Color3.White();
  material.specularColor = Color3.Black();
  // Isolate base terrain lighting from texture UV and tangent-frame differences.
  material.diffuseTexture = null;
  material.bumpTexture = null;
  material.detailMap.isEnabled = false;
  const data = (slope: number) => ({width: 33, height: 33, groundWidthMeters: 10, groundHeightMeters: 10,
    elevations: Float32Array.from({length:1089}, (_, i) => slope * (i % 33) / 32 * 10)}) as TerrainData;
  const coarse = MeshBuilder.CreateGround('coarse', {width:10, height:10, subdivisions: 1}, scene);
  const dense = MeshBuilder.CreateGround('dense', {width:10, height:10, subdivisions:32}, scene);
  coarse.material = dense.material = material;
  attachTerrainReliefNormals(coarse, data(0.5), 10, 10);
  attachTerrainReliefNormals(dense, data(-0.5), 10, 10);
  const sample = async (mesh: typeof coarse) => {
    coarse.setEnabled(mesh === coarse); dense.setEnabled(mesh === dense);
    await material.forceCompilationAsync(mesh);
    scene.render(); scene.render();
    const pixels = await engine.readPixels(48, 48, 32, 32);
    let total = 0;
    for (let i=0; i<pixels.length; i+=4) total += Number(pixels[i]);
    return total / (pixels.length / 4);
  };
  const a = await sample(coarse), b = await sample(dense), repeated = await sample(coarse);
  if (Math.abs(a-b) < 15) throw new Error(`Opposite relief slopes should light differently: ${a}, ${b}`);
  if (Math.abs(a-repeated) > 1) throw new Error(`Per-tile normal binding is stale: ${a}, ${repeated}`);
  // The same map must give the same lighting on a dense or coarse mesh.
  const same = MeshBuilder.CreateGround('same', {width:10, height:10, subdivisions:32}, scene);
  same.material = material;
  // Different mesh normals must not leak into normal-map lighting at another LOD.
  const meshNormals = same.getVerticesData(VertexBuffer.NormalKind)!;
  for (let i = 0; i < meshNormals.length; i += 3) {
    meshNormals[i] = 0.6; meshNormals[i + 1] = 0.8; meshNormals[i + 2] = 0;
  }
  same.setVerticesData(VertexBuffer.NormalKind, meshNormals);
  attachTerrainReliefNormals(same, data(0.5), 10, 10);
  coarse.setEnabled(false); dense.setEnabled(false);
  await material.forceCompilationAsync(same);
  scene.render(); scene.render();
  const pixels = await engine.readPixels(48,48,32,32);
  let total=0; for(let i=0;i<pixels.length;i+=4) total+=Number(pixels[i]);
  const sameLighting = total/(pixels.length/4);
  if (Math.abs(a-sameLighting)>1) throw new Error(`Mesh resolution changes lighting: ${a}, ${sameLighting}`);
  probe.pixelResults = {coarse:a, oppositeSlope:b, rebound:repeated, dense:sameLighting};
  probe.pixelComplete = true;
})().catch(error => { probe.pixelError = String(error); probe.pixelComplete = true; console.error(error); });
