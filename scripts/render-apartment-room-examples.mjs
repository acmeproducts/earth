import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { planApartmentLayout } from "../src/buildings/ApartmentLayoutPlanner.ts";
import { renderFloorPlanSvg } from "../src/buildings/FloorPlan.ts";

const outputDirectory = path.resolve(process.argv[2] ?? "data/apartment-room-examples");
await mkdir(outputDirectory, { recursive: true });

const rectangle = (width, height) => ({
  outer: [
    { x: 0, y: 0 }, { x: width, y: 0 },
    { x: width, y: height }, { x: 0, y: height },
  ],
});

const examples = [
  ["01-single-room.svg", "15 m² apartment — living room", rectangle(5, 3)],
  ["02-standard-apartment.svg", "100 m² apartment — toilet and kitchen", rectangle(10, 10)],
  ["03-long-apartment.svg", "100 m² long apartment — longest-axis splits", rectangle(20, 5)],
];

for (const [filename, title, apartmentPolygon] of examples) {
  const layout = planApartmentLayout({ apartmentPolygon });
  const svg = renderFloorPlanSvg(layout, {
    width: 900,
    height: 600,
    padding: 42,
    title,
  });
  await writeFile(path.join(outputDirectory, filename), svg, "utf8");
  console.log(path.join(outputDirectory, filename));
}
