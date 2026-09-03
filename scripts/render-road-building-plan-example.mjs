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
