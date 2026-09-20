import { Camera, Engine, Scene, UniversalCamera, Vector3, MeshBuilder, VertexBuffer, VertexData,
  StandardMaterial, Color3, Color4, HemisphericLight, DirectionalLight } from '@babylonjs/core';
import { OpenStreetMap, type MapTile } from '../../src/world/OpenStreetMap';
import type { TerrainData } from '../../src/terrain/TerrainData';

void (async () => {
  document.body.style.cssText = 'margin:0;overflow:hidden';
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'width:100vw;height:100vh;display:block';
  document.body.append(canvas);
  const engine = new Engine(canvas, true, { preserveDrawingBuffer: true });
  const scene = new Scene(engine);
  scene.clearColor = new Color4(.7, .8, .86, 1);
  const camera = new UniversalCamera('camera', new Vector3(60, 48, -85), scene);
  camera.fovMode = Camera.FOVMODE_HORIZONTAL_FIXED;
  camera.fov = 1.3;
  camera.setTarget(new Vector3(0, 10, 0));
  camera.attachControl(canvas, true);
  new HemisphericLight('sky', Vector3.Up(), scene).intensity = .8;
  new DirectionalLight('sun', new Vector3(-.5, -1, .4), scene).intensity = 1.5;
  const kind = new URLSearchParams(location.search).get('kind') ?? 'sea';
  const terrain = {
    width: 65, height: 65, elevations: new Float32Array(65 * 65),
    minElevation: -8, maxElevation: 20, groundWidthMeters: 100, groundHeightMeters: 100,
    bounds: { lonWest: 0, lonEast: 1, latSouth: 0, latNorth: 1 },
    worldTile: { level: 14, x: 0, y: 0 }, generationSeed: 1,
  } as TerrainData;
  for (let i = 0; i < terrain.elevations.length; i++) {
    const distance = Math.abs(i % 65 - 32) / 32;
    terrain.elevations[i] = kind === 'river' ? 10 - Math.max(0, 1 - distance * 10) * 3
      : (kind === 'sea' ? -8 : 2) + distance * distance * (kind === 'sea' ? 28 : 18);
  }
  const ground = MeshBuilder.CreateGround('ground', { width: 100, height: 100, subdivisions: 64, updatable: true }, scene);
  const positions = ground.getVerticesData(VertexBuffer.PositionKind)!;
  for (let i = 0; i < terrain.elevations.length; i++) positions[i * 3 + 1] = terrain.elevations[i];
  const normals: number[] = [];
  VertexData.ComputeNormals(positions, ground.getIndices()!, normals);
  ground.updateVerticesData(VertexBuffer.PositionKind, positions);
  ground.updateVerticesData(VertexBuffer.NormalKind, normals);
  const soil = new StandardMaterial('soil', scene);
  soil.diffuseColor = new Color3(.28, .39, .22);
  soil.specularColor = Color3.Black();
  ground.material = soil;
  if (kind === 'sea') {
    const sea = MeshBuilder.CreateGround('sea', { width: 100, height: 100 }, scene);
    const water = new StandardMaterial('sea', scene);
    water.diffuseColor = new Color3(.05, .35, .48);
    sea.material = water;
  }
  const feature = (properties: object, coordinates: number[][]) => ({ id: 1, properties,
    toGeoJSON: () => ({ geometry: { type: 'LineString', coordinates } }) });
  const tile = { x: 0, y: 0, zoom: 14, data: { layers: {
    transportation: { length: 1, feature: () => feature({ class: 'secondary', brunnel: 'bridge' }, [[0, .5], [1, .5]]) },
    ...(kind === 'river' ? { waterway: { length: 1, feature: () => feature({ class: 'river' }, [[.5, 0], [.5, 1]]) } } : {}),
  } } } as unknown as MapTile;
  const layer = await OpenStreetMap.createLayer(scene, [tile], terrain, { meshWidth: 100, meshDepth: 100, metersPerUnit: 1 });
  engine.runRenderLoop(() => scene.render());
  window.addEventListener('resize', () => engine.resize());
  (window as any).__bridge = { scene, engine, camera, layer };
})();
