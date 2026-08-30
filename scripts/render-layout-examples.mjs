import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { planApartmentLayout } from "../src/ApartmentLayoutPlanner.ts";
import { planBuildingLayout } from "../src/BuildingLayoutPlanner.ts";
import { renderFloorPlanSvg } from "../src/FloorPlan.ts";

const outputDirectory = path.resolve(process.argv[2] ?? "data/layout-examples");
await mkdir(outputDirectory, { recursive: true });

const rectangle = (width, height) => ({
  outer: [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ],
});

const examples = [
  {
    filename: "01-at-threshold.svg",
    title: "120 m2 - one apartment",
    layout: planBuildingLayout({
      buildingType: "house",
      buildingPolygon: rectangle(12, 10),
      openings: [
        { id: "door-1", type: "door", start: { x: 5.2, y: 0 }, end: { x: 6.8, y: 0 } },
        { id: "window-1", type: "window", start: { x: 2, y: 10 }, end: { x: 5, y: 10 } },
        { id: "window-2", type: "window", start: { x: 8, y: 10 }, end: { x: 10, y: 10 } },
      ],
    }),
  },
  {
    filename: "02-above-threshold.svg",
    title: "240 m2 - three apartments",
    layout: planBuildingLayout({
      buildingType: "house",
      buildingPolygon: rectangle(20, 12),
      openings: [
        { id: "door-1", type: "door", start: { x: 9, y: 0 }, end: { x: 11, y: 0 } },
        { id: "window-1", type: "window", start: { x: 2, y: 12 }, end: { x: 5, y: 12 } },
        { id: "window-2", type: "window", start: { x: 15, y: 12 }, end: { x: 18, y: 12 } },
      ],
    }),
  },
  {
    filename: "03-large-building.svg",
    title: "392 m2 - four apartments",
    layout: planBuildingLayout({
      buildingType: "apartment-building",
      buildingPolygon: rectangle(28, 14),
      openings: [
        { id: "door-1", type: "door", start: { x: 13, y: 0 }, end: { x: 15, y: 0 } },
        { id: "window-1", type: "window", start: { x: 3, y: 14 }, end: { x: 6, y: 14 } },
        { id: "window-2", type: "window", start: { x: 22, y: 14 }, end: { x: 25, y: 14 } },
      ],
    }),
  },
  {
    filename: "04-apartment-rooms.svg",
    title: "100 m2 apartment - 10 m2 minimum rooms",
    layout: planApartmentLayout({
      apartmentPolygon: rectangle(10, 10),
      openings: [
        { id: "door-1", type: "door", start: { x: 4.2, y: 0 }, end: { x: 5.8, y: 0 } },
        { id: "window-1", type: "window", start: { x: 0, y: 2 }, end: { x: 0, y: 4 } },
        { id: "window-2", type: "window", start: { x: 10, y: 6 }, end: { x: 10, y: 8 } },
      ],
    }),
  },
  {
    filename: "05-tapered-building.svg",
    title: "Tapered building footprint",
    layout: planBuildingLayout({
      buildingType: "apartment-building",
      buildingPolygon: {
        outer: [
          { x: 0, y: 0 },
          { x: 24, y: 0 },
          { x: 20, y: 13 },
          { x: 4, y: 13 },
        ],
      },
      openings: [
        { id: "door-1", type: "door", start: { x: 10.8, y: 0 }, end: { x: 12.5, y: 0 } },
        { id: "window-1", type: "window", start: { x: 5, y: 13 }, end: { x: 8, y: 13 } },
        { id: "window-2", type: "window", start: { x: 16, y: 13 }, end: { x: 19, y: 13 } },
      ],
    }),
  },
  {
    filename: "06-angled-hexagon.svg",
    title: "Angled hexagonal footprint",
    layout: planBuildingLayout({
      buildingType: "apartment-building",
      buildingPolygon: {
        outer: [
          { x: 0, y: 2 },
          { x: 4, y: 0 },
          { x: 20, y: 0 },
          { x: 24, y: 6 },
          { x: 20, y: 12 },
          { x: 4, y: 12 },
        ],
      },
      openings: [
        { id: "door-1", type: "door", start: { x: 10, y: 0 }, end: { x: 12, y: 0 } },
        { id: "window-1", type: "window", start: { x: 6, y: 12 }, end: { x: 9, y: 12 } },
        { id: "window-2", type: "window", start: { x: 23, y: 7.5 }, end: { x: 22, y: 9 } },
      ],
    }),
  },
];

for (const example of examples) {
  const svg = renderFloorPlanSvg(example.layout, {
    width: 900,
    height: 600,
    padding: 42,
    title: example.title,
  });
  await writeFile(path.join(outputDirectory, example.filename), svg, "utf8");
  console.log(path.join(outputDirectory, example.filename));
}
