import assert from "node:assert/strict";
import test from "node:test";
import { mergeOverlappingBuildings } from "../src/CompositeBuildings.ts";
import { planBuilding } from "../src/BuildingPlanner.ts";
import { compositeBuildingGeometry } from "../src/procedural/CompositeBuildingGeometry.ts";

const rect = (x, z, width, depth) => ({ outer: [[x,z],[x+width,z],[x+width,z+depth],[x,z+depth],[x,z]], holes: [] });
const part = (id, polygon, bottom, top) => ({ id, polygon, properties: { render_min_height: bottom, render_height: top } });
const merged = (parts) => {
  const sources = mergeOverlappingBuildings(parts);
  assert.equal(sources.length, 1);
  return planBuilding(sources[0]);
};
const geometry = (plan, scale = 1) => compositeBuildingGeometry(plan.heightBands, ([x,z]) => ({x:x/scale,z:z/scale}), (height) => height/scale);

for (const detail of ["createDetailed", "createFar"]) {
  test(`${detail} merges stepped, ordinary and courtyard buildings in either order`, async () => {
    const { NullEngine, Scene, TransformNode, VertexBuffer } = await import("@babylonjs/core");
    const { ProceduralBuildingRenderer } = await import("../src/procedural/ProceduralBuildingRenderer.ts");
    const engine = new NullEngine(), scene = new Scene(engine);
    try {
      const stepped = merged([part("base", rect(1,1,10,10), 0, 6), part("tower", rect(4,4,4,4), 0, 12)]);
      const ordinary = planBuilding(part("ordinary", rect(13,2,5,5), 0, 6));
      const courtyardPolygon = rect(13,10,6,6);
      courtyardPolygon.holes = [rect(15,12,2,2).outer];
      const courtyard = planBuilding(part("courtyard", courtyardPolygon, 0, 6));
      const terrain = { elevations: new Float32Array([10,10,10,10]), minElevation: 10, maxElevation: 10,
        width: 2, height: 2, bounds: { lonWest: 0, lonEast: 20, latSouth: 0, latNorth: 20 } };
      const options = { meshWidth: 20, meshDepth: 20, metersPerUnit: 1, renderWholeBuildingFootprints: true };
      for (const plans of [[stepped, ordinary, courtyard], [courtyard, ordinary, stepped]]) {
        const meshes = plans.map((plan) => ProceduralBuildingRenderer[detail](scene, plan, terrain, options));
        assert.ok(meshes.every(Boolean));
        const vertexCount = meshes.reduce((sum, mesh) => sum + mesh.getTotalVertices(), 0);
        const root = new TransformNode("mixed-tile", scene);
        const combined = ProceduralBuildingRenderer.merge(meshes,
          detail === "createFar" ? "farBuildings" : "buildings", root);
        assert.ok(combined);
        assert.equal(combined.getTotalVertices(), vertexCount);
        for (const [kind, stride] of [[VertexBuffer.PositionKind, 3], [VertexBuffer.NormalKind, 3],
          [VertexBuffer.UVKind, 2], [VertexBuffer.UV2Kind, 2], [VertexBuffer.ColorKind, 4]]) {
          const data = combined.getVerticesData(kind);
          assert.equal(data?.length, vertexCount * stride, `missing or malformed ${kind}`);
          assert.ok(data.every(Number.isFinite));
        }
        root.dispose(false, true);
      }
    } finally { scene.dispose(); engine.dispose(); }
  });
}
function horizontalArea(mesh, y, normalY) {
  let area = 0;
  for (let i=0; i<mesh.positions.length; i+=9) {
    if (Math.abs(mesh.normals[i+1]-normalY)>1e-8 || Math.abs(mesh.positions[i+1]-y)>1e-8) continue;
    const p=mesh.positions;
    area += Math.abs((p[i+3]-p[i])*(p[i+8]-p[i+2])-(p[i+6]-p[i])*(p[i+5]-p[i+2]))/2;
  }
  return area;
}
function volume(mesh) {
  let sum=0;
  const p=mesh.positions;
  for(let i=0;i<p.length;i+=9) {
    const [ax,ay,az,bx,by,bz,cx,cy,cz]=p.slice(i,i+9);
    sum += ax*(by*cz-bz*cy)-ay*(bx*cz-bz*cx)+az*(bx*cy-by*cx);
  }
  return Math.abs(sum/6);
}

test("wide base and narrower tower retain their cross-sections and one exposed terrace", () => {
  const plan = merged([part("base",rect(0,0,10,10),0,10),part("tower",rect(3,3,4,4),0,30)]);
  assert.deepEqual(plan.heightBands.map((b)=>[b.minimumHeightMeters,b.heightMeters]), [[0,10],[10,30]]);
  const mesh=geometry(plan);
  assert.equal(horizontalArea(mesh,10,1),84);
  assert.equal(horizontalArea(mesh,10,-1),0, "no internal tower floor");
  assert.equal(horizontalArea(mesh,30,1),16);
  assert.equal(horizontalArea(mesh,0,-1),100);
  assert.ok(Math.abs(volume(mesh)-1320)<1e-8);
});

test("a shorter part entirely inside a taller volume keeps ordinary detailed rendering", () => {
  const plan = merged([part("tall",rect(0,0,10,10),0,30),part("inside",rect(3,3,4,4),0,10)]);
  assert.equal(plan.heightBands, undefined);
});

test("parts stacked at an exact height connect and preserve exposed overhang undersides", () => {
  const plan=merged([part("base",rect(3,3,4,4),0,10),part("overhang",rect(0,0,10,10),10,20)]);
  const mesh=geometry(plan);
  assert.equal(horizontalArea(mesh,10,-1),84);
  assert.equal(horizontalArea(mesh,10,1),0);
  assert.equal(horizontalArea(mesh,20,1),100);
  assert.ok(Math.abs(volume(mesh)-1160)<1e-8);
});

test("one podium supports disjoint upper towers without a roof spanning the gap", () => {
  const plan=merged([part("base",rect(0,0,10,10),0,10),part("a",rect(1,1,2,2),0,20),part("b",rect(7,7,2,2),0,30)]);
  assert.equal(plan.heightBands[1].footprints.length,2);
  const mesh=geometry(plan);
  assert.equal(horizontalArea(mesh,10,1),92);
  assert.equal(horizontalArea(mesh,20,1),4);
  assert.equal(horizontalArea(mesh,30,1),4);
  assert.ok(Math.abs(volume(mesh)-1120)<1e-8);
});

test("courtyard voids survive each band and cap triangulation", () => {
  const courtyard=rect(0,0,10,10);
  courtyard.holes=[rect(2,2,6,6).outer];
  const plan=merged([part("base",courtyard,0,10),part("tower",rect(0,0,2,10),0,20)]);
  const mesh=geometry(plan);
  assert.equal(horizontalArea(mesh,0,-1),64);
  assert.equal(horizontalArea(mesh,10,1),44);
  assert.equal(horizontalArea(mesh,20,1),20);
  assert.ok(Math.abs(volume(mesh)-840)<1e-8);
});

test("band geometry scales consistently and merging an existing composite retains heights", () => {
  const parts=[part("base",rect(0,0,10,10),0,10),part("tower",rect(3,3,4,4),0,30)];
  const plan=merged(parts);
  const scale=10;
  assert.ok(Math.abs(volume(geometry(plan,scale))*scale**3-1320)<1e-8);
  assert.deepEqual(merged([...parts].reverse()),plan);
  const again=merged([...mergeOverlappingBuildings(parts),part("new",rect(4,4,2,2),30,40)]);
  assert.equal(again.heightBands.at(-1).heightMeters,40);
  assert.equal(horizontalArea(geometry(again),30,1),12);
});

test("detailed and far renderers preserve the same stepped shell and terrace elevations", async () => {
  const { NullEngine, Scene, VertexBuffer } = await import("@babylonjs/core");
  const { ProceduralBuildingRenderer } = await import("../src/procedural/ProceduralBuildingRenderer.ts");
  const { lonLatToScene } = await import("../src/Geo.ts");
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const plan = merged([part("base",rect(0,0,10,10),0,10),part("tower",rect(3,3,4,4),0,30)]);
  const terrain = {
    elevations: new Float32Array([10,10,10,10]), minElevation: 10, maxElevation: 10,
    width: 2, height: 2, bounds: { lonWest: 0, lonEast: 10, latSouth: 0, latNorth: 10 },
  };
  const options = { meshWidth: 10, meshDepth: 10, metersPerUnit: 1, renderWholeBuildingFootprints: true };
  const projectedRectangleArea = (polygon) => {
    const [a,,b] = polygon.outer.map(([lon,lat]) => lonLatToScene(lon,lat,terrain.bounds,10,10));
    return Math.abs((b.x-a.x)*(b.z-a.z));
  };
  const towerArea = projectedRectangleArea(rect(3,3,4,4));
  const terraceArea = projectedRectangleArea(rect(0,0,10,10)) - towerArea;
  try {
    const meshes = ["createDetailed", "createFar"].map((method) => ProceduralBuildingRenderer[method](scene,plan,terrain,options));
    for (const mesh of meshes) {
      assert.ok(mesh);
      assert.equal(mesh.metadata.heightBandCount,2);
      const data = { positions: mesh.getVerticesData(VertexBuffer.PositionKind), normals: mesh.getVerticesData(VertexBuffer.NormalKind) };
      assert.ok(Math.abs(horizontalArea(data,20,1)-terraceArea)<1e-5);
      assert.ok(Math.abs(horizontalArea(data,40,1)-towerArea)<1e-5);
      assert.equal(horizontalArea(data,20,-1),0);
    }
    assert.deepEqual(meshes[0].getVerticesData(VertexBuffer.PositionKind),meshes[1].getVerticesData(VertexBuffer.PositionKind));
  } finally {
    scene.dispose();
    engine.dispose();
  }
});
