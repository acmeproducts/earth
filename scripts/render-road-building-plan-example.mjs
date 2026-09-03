import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { renderRoadAndBuildingPlanSvg } from "../src/RoadAndBuildingPlanImage.ts";
import { planRoadsAndBuildings } from "../src/RoadAndBuildingPlanner.ts";

const paved = {
  roadClass: "primary", widthMeters: 7, shoulderWidthMeters: 1.5,
  surface: "paved", visualStyle: "marked", structure: "surface", layer: 0, isTunnel: false,
};
const local = {
  roadClass: "minor", widthMeters: 4, shoulderWidthMeters: 0.9,
  surface: "paved", visualStyle: "paved", structure: "surface", layer: 0, isTunnel: false,
};
const outputDirectory = path.resolve(process.argv[2] ?? "data/road-building-plan-examples");
await mkdir(outputDirectory, { recursive: true });

const plan = planRoadsAndBuildings([
  { id: "main-street", paths: [[{ x: -45, z: -5 }, { x: 45, z: -5 }]], appearance: paved },
  { id: "cross-street", paths: [[{ x: 4, z: -30 }, { x: 4, z: 30 }]], appearance: local },
], [
  { id: "building-a", outline: [{ x: -31, z: 6 }, { x: -14, z: 6 }, { x: -14, z: 22 }, { x: -31, z: 22 }] },
  { id: "building-b", outline: [{ x: 14, z: 5 }, { x: 34, z: 5 }, { x: 31, z: 23 }, { x: 14, z: 20 }] },
], { meshWidth: 100, meshDepth: 70, metersPerUnit: 1 });

const filename = path.join(outputDirectory, "site-plan.svg");
await writeFile(filename, renderRoadAndBuildingPlanSvg(plan, {
  width: 1000, height: 700, padding: 36, title: "Road and building planning", showLabels: true,
}), "utf8");
console.log(filename);

const track = {
  roadClass: "track", widthMeters: 2.5, shoulderWidthMeters: 0.5,
  surface: "unpaved", visualStyle: "unpaved", structure: "surface", layer: 0, isTunnel: false,
};
const village = planRoadsAndBuildings([
  { id: "high-street", paths: [[{ x: -70, z: 0 }, { x: 70, z: 0 }]], appearance: paved },
  { id: "lane-north", paths: [[{ x: -20, z: -50 }, { x: -20, z: 50 }]], appearance: local },
  { id: "lane-east", paths: [[{ x: 30, z: 0 }, { x: 42, z: 22 }, { x: 65, z: 40 }]], appearance: local },
  { id: "farm-track", paths: [[{ x: -70, z: -35 }, { x: 10, z: -35 }]], appearance: track },
], [
  { id: "house-a", outline: [{ x: -60, z: 10 }, { x: -46, z: 10 }, { x: -46, z: 22 }, { x: -60, z: 22 }] },
  { id: "house-b", outline: [{ x: -38, z: 8 }, { x: -26, z: 8 }, { x: -26, z: 20 }, { x: -38, z: 20 }] },
  { id: "house-c", outline: [{ x: -12, z: 10 }, { x: 2, z: 10 }, { x: 2, z: 24 }, { x: -12, z: 24 }] },
  { id: "house-d", outline: [{ x: 8, z: 12 }, { x: 22, z: 8 }, { x: 26, z: 20 }, { x: 12, z: 24 }] },
  { id: "barn", outline: [{ x: -52, z: -28 }, { x: -34, z: -28 }, { x: -34, z: -14 }, { x: -52, z: -14 }] },
  { id: "cottage", outline: [{ x: -8, z: -26 }, { x: 6, z: -26 }, { x: 6, z: -14 }, { x: -8, z: -14 }] },
  { id: "mill", outline: [{ x: 40, z: -30 }, { x: 58, z: -30 }, { x: 58, z: -12 }, { x: 40, z: -12 }] },
], { meshWidth: 160, meshDepth: 120, metersPerUnit: 1 }, [
  { id: "mapped-lamp/1", position: { x: -26, z: 6 } },
]);
const villageFilename = path.join(outputDirectory, "village-plan.svg");
await writeFile(villageFilename, renderRoadAndBuildingPlanSvg(village, {
  width: 1200, height: 900, padding: 36, title: "Village plan: roads, plots, street lamps", showLabels: true,
}), "utf8");
console.log(villageFilename);
