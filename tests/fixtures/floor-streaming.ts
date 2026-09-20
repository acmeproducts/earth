import { Color4, Engine, FreeCamera, HemisphericLight, Ray, Scene, TransformNode, Vector3 } from '@babylonjs/core';
import { planBuilding } from '../../src/buildings/BuildingPlanner';
import { ProceduralBuildingRenderer } from '../../src/procedural/ProceduralBuildingRenderer';

const probe = window as any;
const check = (condition: unknown, message: string): void => { if (!condition) throw new Error(message); };

void (async () => {
  const canvas = document.getElementById('renderCanvas') as HTMLCanvasElement;
  const engine = new Engine(canvas, false, { preserveDrawingBuffer: true, stencil: false });
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.3, 0.5, 0.7, 1);
  new HemisphericLight('light', new Vector3(0, 1, 0), scene).intensity = 1;
  const camera = new FreeCamera('camera', new Vector3(0, 12, -100), scene);
  camera.minZ = 0.05;
  scene.activeCamera = camera;
  const tile = new TransformNode('tile', scene);
  const plan = planBuilding({ id: 'browser-floor-streaming', properties: {
    building: 'apartments', levels: 8, render_height: 24.8,
  }, polygon: { outer: [[0.2, 0.3], [0.8, 0.3], [0.8, 0.7], [0.2, 0.7], [0.2, 0.3]], holes: [] } });
  plan.detailSeed = 12345;
  const exterior = ProceduralBuildingRenderer.merge([
    ProceduralBuildingRenderer.createDetailed(scene, plan, {
      elevations: new Float32Array([10, 10, 10, 10]), minElevation: 10, maxElevation: 10,
      width: 2, height: 2, bounds: { lonWest: 0, lonEast: 1, latSouth: 0, latNorth: 1 },
    } as any, { meshWidth: 100, meshDepth: 100, metersPerUnit: 1 })!,
  ], 'buildings', tile)!;
  const frame = () => new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(() => resolve()));
  const wait = async (condition: () => boolean): Promise<number> => {
    let frames = 0;
    do { await frame(); check(++frames < 1800, 'Floor streaming timed out'); } while (!condition());
    return frames;
  };
  engine.runRenderLoop(() => scene.render());
  const results = [];
  probe.pixelScreenshots = {};
  for (const [name, width, height, floor] of [['desktop', 997, 731, 0], ['mobile', 390, 844, 5]] as const) {
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    engine.setSize(width, height);
    camera.position.set(0, 11.8 + floor * 3.1, -23);
    camera.setTarget(new Vector3(0, camera.position.y, 0));
    const start = performance.now();
    const frames = await wait(() => exterior.metadata.loadedInteriors.some((entry: any) => entry.pending.floor.index === floor));
    const firstFloorMs = performance.now() - start;
    const loaded = exterior.metadata.loadedInteriors.find((entry: any) => entry.pending.floor.index === floor);
    check(!loaded.mesh.metadata.furnitureReady, 'Furniture delayed floor entry');
    check(exterior.metadata.loadedInteriorFloorCount < 8, 'Entire building was generated');
    await wait(() => exterior.metadata.loadingInteriorCount === 0);
    // Select an open room position instead of placing the camera inside a seeded partition.
    let view: { origin: Vector3; direction: Vector3; score: number } | undefined;
    const meshes = loaded.mesh.getChildMeshes().filter((mesh: any) => mesh.isEnabled() && mesh.getTotalVertices() > 0);
    for (const x of [-25, -15, -5, 5, 15, 25]) for (const z of [-15, -5, 5, 15]) {
      const origin = new Vector3(x, 11.8 + floor * 3.1, z);
      const rays = Array.from({ length: 8 }, (_, index) => {
        const direction = new Vector3(Math.cos(index * Math.PI / 4), 0, Math.sin(index * Math.PI / 4));
        const ray = new Ray(origin, direction, 40);
        const distance = Math.min(40, ...meshes.map((mesh: any) => {
          const hit = mesh.intersects(Ray.Transform(ray, mesh.computeWorldMatrix(true).clone().invert()));
          return hit.hit ? hit.distance : 40;
        }));
        return { direction, distance };
      });
      if (Math.min(...rays.map((ray) => ray.distance)) < 0.8) continue;
      const longest = rays.reduce((a, b) => a.distance > b.distance ? a : b);
      const score = rays.reduce((sum, ray) => sum + Math.min(ray.distance, 8), 0);
      if (!view || score > view.score) view = { origin, direction: longest.direction, score };
    }
    check(view, 'No open interior position');
    camera.position.copyFrom(view!.origin);
    camera.setTarget(view!.origin.add(view!.direction.scale(10)).add(new Vector3(0, -1, 0)));
    for (let i = 0; i < 10; i++) await frame();
    check(Math.abs(camera.position.x) < 30 && Math.abs(camera.position.z) < 20, 'Ready floor still blocks entry');
    const pixels = await engine.readPixels(0, 0, width, height);
    const bytes = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
    const colors = new Set<number>();
    for (let i = 0; i < bytes.length; i += 64) colors.add((bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]);
    check(colors.size > 20, `Interior canvas is blank (${colors.size} colors)`);
    probe.pixelScreenshots[name] = canvas.toDataURL('image/png').split(',')[1];
    results.push({ name, floor, frames, firstFloorMs, residentFloors: exterior.metadata.loadedInteriors.map((entry: any) => entry.pending.floor.index), colors: colors.size });
    camera.position.x = 1000;
    await wait(() => exterior.metadata.loadedInteriorFloorCount === 0);
  }
  tile.dispose(false, true);
  await frame();
  check(scene.meshes.length === 0, 'Disposed tile left interior meshes behind');
  engine.stopRenderLoop();
  probe.pixelResults = results;
  probe.pixelComplete = true;
})().catch((error) => { probe.pixelError = String(error?.stack ?? error); });
