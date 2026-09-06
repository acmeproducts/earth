import {
  Color3, Color4, Constants, DirectionalLight, Engine, FreeCamera, HemisphericLight,
  MeshBuilder, Scene, SSRRenderingPipeline, StandardMaterial, Vector3, VertexBuffer, VertexData, WebGPUEngine,
} from '@babylonjs/core';
import { attachShoreline } from '../../src/Shoreline';
import { createWaterPlane } from '../../src/Water';
import { createTerrainLakeLayer } from '../../src/TerrainLakeSurface';

async function main(): Promise<void> {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'width:100vw;height:100vh;display:block';
  document.body.style.margin = '0';
  document.body.append(canvas);
  const webgpu = new URLSearchParams(location.search).has('webgpu');
  const kind = new URLSearchParams(location.search).has('lake') ? 'lake' : 'ocean';
  const engine = webgpu ? new WebGPUEngine(canvas) : new Engine(canvas, true);
  if (engine instanceof WebGPUEngine) await engine.initAsync();
  engine.useReverseDepthBuffer = !webgpu;
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.53, 0.71, 0.82, 1);
  const camera = new FreeCamera('camera', new Vector3(-20, 8, -15), scene);
  camera.minZ = 0.05;
  camera.setTarget(Vector3.Zero());
  if (!webgpu) {
    const reflections = new SSRRenderingPipeline('fixture-reflections', scene, [camera], false, Constants.TEXTURETYPE_UNSIGNED_BYTE);
    reflections.reflectivityThreshold = 0.04;
    reflections.maxDistance = 50;
  }
  const sky = new HemisphericLight('sky', new Vector3(0, 1, 0), scene);
  sky.intensity = 0.75;
  const sun = new DirectionalLight('sun', new Vector3(0.4, -1, 0.3), scene);
  sun.intensity = 1.2;
  const ground = MeshBuilder.CreateGround('fixture', { width: 160, height: 160, subdivisions: 80, updatable: true }, scene);
  const positions = ground.getVerticesData(VertexBuffer.PositionKind)!;
  for (let i = 0; i < positions.length; i += 3) {
    positions[i + 1] = (positions[i] - 2 * Math.sin(positions[i + 2] * 0.12)) * 0.09 + (kind === 'lake' ? 5 : 0);
  }
  const normals = new Float32Array(positions.length);
  VertexData.ComputeNormals(positions, ground.getIndices()!, normals);
  ground.updateVerticesData(VertexBuffer.PositionKind, positions, true);
  ground.updateVerticesData(VertexBuffer.NormalKind, normals);
  const sand = new StandardMaterial('sand', scene);
  sand.diffuseColor = new Color3(0.56, 0.48, 0.33);
  sand.specularColor = Color3.Black();
  ground.material = sand;
  if (kind === 'lake') {
    const layer = await createTerrainLakeLayer(scene, [{
      sourceId: 'fixture-lake', elevationMeters: 5, holes: [],
      outline: [{x:-80,z:-80}, {x:0,z:-80}, {x:0,z:80}, {x:-80,z:80}],
    }], { meshWidth: 160, meshDepth: 160, metersPerUnit: 1, terrain: ground });
    layer.root.setEnabled(true);
  } else {
    createWaterPlane(scene, { width: 160, height: 160, metersPerUnit: 1, kind });
    await attachShoreline(ground, positions, ground.getIndices()!, 1, undefined, { kind });
  }
  (window as unknown as { __shoreScene: Scene }).__shoreScene = scene;
  engine.runRenderLoop(() => scene.render());
}
void main();
