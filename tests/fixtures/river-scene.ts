import { Engine, Scene, UniversalCamera, Vector3, MeshBuilder, VertexBuffer, VertexData,
  StandardMaterial, Color3, Color4, HemisphericLight, DirectionalLight } from '@babylonjs/core';
import { OpenStreetMap, type MapTile } from '../../src/world/OpenStreetMap';
import { TerrainSurface } from '../../src/terrain/TerrainSurface';
import { carveTerrainWaterways } from '../../src/terrain/TerrainWaterways';
import type { TerrainData } from '../../src/terrain/TerrainData';

void (async () => {
  document.body.style.cssText = 'margin:0;overflow:hidden';
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'width:100vw;height:100vh;display:block';
  document.body.append(canvas);
  const engine = new Engine(canvas, true, { preserveDrawingBuffer: true });
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.45, 0.65, 0.75, 1);
  const camera = new UniversalCamera('camera', new Vector3(44, 65, -55), scene);
  camera.setTarget(new Vector3(0, 9, 0));
  camera.attachControl(canvas, true);
  new HemisphericLight('sky', Vector3.Up(), scene).intensity = 0.7;
  new DirectionalLight('sun', new Vector3(-0.5, -1, 0.4), scene).intensity = 2;
  const terrain = {
    width: 65, height: 65, elevations: new Float32Array(65 * 65),
    minElevation: 5, maxElevation: 15, groundWidthMeters: 100, groundHeightMeters: 100,
    bounds: { lonWest: 0, lonEast: 1, latSouth: 0, latNorth: 1 },
    worldTile: { level: 14, x: 0, y: 0 }, generationSeed: 1,
  } as TerrainData;
  for (let row = 0; row < 65; row++) for (let col = 0; col < 65; col++) {
    terrain.elevations[row * 65 + col] = 15 - row / 64 * 10 + Math.sin(col / 8) * 0.3;
  }
  const tile = { x: 0, y: 0, zoom: 14, data: { layers: {
    transportation: { length: 1, feature: () => ({ id: 2, properties: { class: 'secondary', surface: 'asphalt' },
      toGeoJSON: () => ({ geometry: { type: 'LineString', coordinates: [[0.1, 0.5], [0.9, 0.5]] } }),
    }) },
    waterway: { length: 1, feature: () => ({ id: 1, properties: { class: 'river' },
      toGeoJSON: () => ({ geometry: { type: 'LineString', coordinates:
        [[0.5, 1], [0.48, 0.8], [0.4, 0.65], [0.45, 0.5], [0.6, 0.35], [0.63, 0.2], [0.55, 0]] } }),
    }) },
  } } } as unknown as MapTile;
  const options = { meshWidth: 100, meshDepth: 100, metersPerUnit: 1 };
  await carveTerrainWaterways(terrain, OpenStreetMap.collectWaterwaySegments([tile], terrain, options), options);
  const ground = MeshBuilder.CreateGround('banks', { width: 100, height: 100, subdivisions: 64, updatable: true }, scene);
  const positions = ground.getVerticesData(VertexBuffer.PositionKind)!;
  for (let i = 0; i < terrain.elevations.length; i++) positions[i * 3 + 1] = terrain.elevations[i];
  const normals: number[] = [];
  VertexData.ComputeNormals(positions, ground.getIndices()!, normals);
  ground.updateVerticesData(VertexBuffer.PositionKind, positions);
  ground.updateVerticesData(VertexBuffer.NormalKind, normals);
  const soil = new StandardMaterial('ground', scene);
  soil.diffuseColor = new Color3(0.24, 0.32, 0.19);
  soil.specularColor = Color3.Black();
  ground.material = soil;
  const renderOptions = { ...options, terrainSurface: TerrainSurface.fromGroundMesh(ground, 100, 100),
    planning: OpenStreetMap.planRoadsAndBuildings([tile], terrain, options) };
  const first = await OpenStreetMap.createLayer(scene, [tile], terrain, renderOptions);
  const second = await OpenStreetMap.createLayer(scene, [tile], terrain, renderOptions);
  OpenStreetMap.disposeLayer(first.root);
  engine.runRenderLoop(() => scene.render());
  window.addEventListener('resize', () => engine.resize());
  (window as any).__river = { scene, mesh: second.meshes.find(mesh => mesh.name === 'waterways'), engine };
})();
