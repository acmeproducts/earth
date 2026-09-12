import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { planApartmentLayout } from "../src/ApartmentLayoutPlanner.ts";
import { planBuildingLayout } from "../src/BuildingLayoutPlanner.ts";
import { planningFrameForPolygon } from "../src/PlanningFrame.mjs";
import { renderFloorPlanSvg } from "../src/FloorPlan.ts";

const inputPath = process.argv[2];
if (!inputPath) {
  throw new Error("Usage: yarn layouts:captured <earth-building-layouts.json> [output-directory]");
}
const outputDirectory = path.resolve(process.argv[3] ?? "data/captured-building-layouts");
const capture = JSON.parse(await readFile(path.resolve(inputPath), "utf8"));
if (capture.format !== "earth-building-layout-captures" || !Array.isArray(capture.buildings)) {
  throw new Error("The input is not an Earth building-layout capture file.");
}
await mkdir(outputDirectory, { recursive: true });

const cards = [];
const summary = [];
for (let index = 0; index < capture.buildings.length; index++) {
  const building = capture.buildings[index];
  const stem = `${String(index + 1).padStart(3, "0")}-${safeName(building.id)}`;
  try {
    const layout = planBuildingLayout(building.plannerInput);
    const buildingSvg = renderFloorPlanSvg(layout, {
      width: 900,
      height: 600,
      padding: 42,
      title: `${building.id} — building layout`,
    });
    const buildingFilename = `${stem}-building.svg`;
    await writeFile(path.join(outputDirectory, buildingFilename), buildingSvg, "utf8");
    const apartmentFiles = [];
    const apartmentLayouts = [];
    const planningFrame = planningFrameForPolygon(layout.boundary.outer);
    for (const room of layout.rooms.filter((room) => room.type === "apartment")) {
      const apartment = planApartmentLayout({
        apartmentPolygon: room.polygon,
        planningFrame,
        openings: [...(layout.openings ?? []), ...(building.facadeOpenings ?? [])]
          .filter((opening) => openingTouchesBoundary(opening, room.polygon.outer)),
      });
      const apartmentFilename = `${stem}-${safeName(room.id)}.svg`;
      await writeFile(path.join(outputDirectory, apartmentFilename), renderFloorPlanSvg(apartment, {
        width: 900,
        height: 600,
        padding: 42,
        title: `${building.id} — ${room.id}`,
      }), "utf8");
      apartmentFiles.push(apartmentFilename);
      apartmentLayouts.push(apartment);
    }
    const interiorFilename = `${stem}-interior.svg`;
    await writeFile(path.join(outputDirectory, interiorFilename), renderFloorPlanSvg({
      boundary: layout.boundary,
      rooms: [
        ...layout.rooms.filter((room) => room.type !== "apartment"),
        ...apartmentLayouts.flatMap((apartment, apartmentIndex) => apartment.rooms.map((room) => ({
          ...room,
          id: `apartment-${apartmentIndex + 1}-${room.id}`,
          label: `A${apartmentIndex + 1}–${room.label ?? room.type}`,
        }))),
      ],
      openings: uniqueOpenings([
        ...(layout.openings ?? []),
        ...apartmentLayouts.flatMap((apartment) => apartment.openings ?? []),
      ]),
    }, {
      width: 900,
      height: 600,
      padding: 42,
      title: `${building.id} — room layout`,
    }), "utf8");
    summary.push({ id: building.id, status: "planned", rooms: layout.rooms.length, apartmentFiles });
    cards.push(card(building.id, "planned", [buildingFilename, interiorFilename, ...apartmentFiles]));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const fallbackFilename = `${stem}-failed-footprint.svg`;
    await writeFile(path.join(outputDirectory, fallbackFilename), renderFloorPlanSvg({
      boundary: building.plannerInput.buildingPolygon,
      rooms: [],
      openings: building.facadeOpenings ?? building.plannerInput.openings,
    }, {
      width: 900,
      height: 600,
      padding: 42,
      title: `${building.id} — planner failed: ${message}`,
    }), "utf8");
    summary.push({ id: building.id, status: "failed", error: message });
    cards.push(card(building.id, `failed: ${message}`, [fallbackFilename]));
  }
}

await writeFile(path.join(outputDirectory, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
await writeFile(path.join(outputDirectory, "index.html"), `<!doctype html>
<html><head><meta charset="utf-8"><title>Captured building layouts</title>
<style>body{font:14px system-ui;background:#eee;margin:24px}section{background:white;padding:16px;margin:0 0 20px;border-radius:8px}img{width:min(900px,100%);display:block;margin:12px 0;border:1px solid #bbb}code{word-break:break-all}</style>
</head><body><h1>Captured building layouts</h1>${cards.join("")}</body></html>`, "utf8");
console.log(`Rendered ${summary.length} captured buildings to ${outputDirectory}`);

function card(id, status, files) {
  return `<section><h2><code>${escapeHtml(id)}</code></h2><p>${escapeHtml(status)}</p>${files.map((file) => `<img src="${encodeURI(file)}" alt="${escapeHtml(file)}">`).join("")}</section>`;
}

function uniqueOpenings(openings) {
  return [...new Map(openings.map((opening) => [
    `${opening.type}:${opening.start.x},${opening.start.y}:${opening.end.x},${opening.end.y}`,
    opening,
  ])).values()];
}

function openingTouchesBoundary(opening, polygon) {
  const center = { x: (opening.start.x + opening.end.x) / 2, y: (opening.start.y + opening.end.y) / 2 };
  return polygon.some((start, index) => pointOnSegment(center, start, polygon[(index + 1) % polygon.length]));
}

function pointOnSegment(point, start, end) {
  const cross = (end.x - start.x) * (point.y - start.y) - (end.y - start.y) * (point.x - start.x);
  return Math.abs(cross) < 1e-5 && point.x >= Math.min(start.x, end.x) - 1e-5 &&
    point.x <= Math.max(start.x, end.x) + 1e-5 && point.y >= Math.min(start.y, end.y) - 1e-5 &&
    point.y <= Math.max(start.y, end.y) + 1e-5;
}

function safeName(value) {
  return String(value).replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 90) || "building";
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}
