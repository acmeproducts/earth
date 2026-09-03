import assert from "node:assert/strict";
import test from "node:test";

import { renderRoadAndBuildingPlanSvg } from "../src/RoadAndBuildingPlanImage.ts";
import { planRoadsAndBuildings } from "../src/RoadAndBuildingPlanner.ts";

const markedRoad = {
  roadClass: "primary",
  widthMeters: 4,
  shoulderWidthMeters: 1,
  surface: "paved",
  visualStyle: "marked",
  structure: "surface",
  layer: 0,
  isTunnel: false,
};

test("renders the road/building planning result as a standalone SVG", () => {
  const plan = planRoadsAndBuildings([{
    id: "road&1",
    paths: [[{ x: -8, z: 0 }, { x: 8, z: 0 }]],
    appearance: markedRoad,
  }], [{
    id: "building<1>",
    outline: [
      { x: -4, z: 3 }, { x: 0, z: 3 }, { x: 0, z: 7 }, { x: -4, z: 7 },
    ],
    holes: [[
      { x: -3, z: 4 }, { x: -1, z: 4 }, { x: -1, z: 6 }, { x: -3, z: 6 },
    ]],
  }], { meshWidth: 20, meshDepth: 20, metersPerUnit: 1 }, [
    { id: "lamp:1", position: { x: 5, z: -6 } },
  ]);

  const svg = renderRoadAndBuildingPlanSvg(plan, {
    width: 640,
    height: 400,
    title: "Site plan",
    showLabels: true,
  });

  assert.match(svg, /^<svg[^>]+width="640"[^>]+height="400"/);
  assert.match(svg, /aria-label="Site plan"/);
  assert.match(svg, /data-kind="shoulder" data-source-id="road&amp;1"/);
  assert.match(svg, /data-kind="road" data-source-id="road&amp;1"/);
  assert.match(svg, /data-kind="road-marking" data-source-id="road&amp;1"/);
  assert.match(svg, /data-kind="building-site" data-source-id="building&lt;1&gt;"/);
  assert.match(svg, /data-kind="plot" data-source-id="building&lt;1&gt;"/);
  assert.match(svg, /data-kind="street-lamp" data-source-id="lamp:1" data-lamp-source="mapped"/);
  const plotIndex = svg.indexOf('data-kind="plot"');
  assert.ok(plotIndex >= 0 && plotIndex < svg.indexOf('data-kind="shoulder"'),
    "plots must render beneath the road bed");
  assert.match(svg, /fill-rule="evenodd"/);
  assert.equal(svg.match(/>road&amp;1<\/text>/g)?.length, 1);
  assert.equal(svg.match(/data-kind="road-marking"/g)?.length, 1);
  assert.doesNotMatch(svg, /road&1|building<1>/);
});

test("keeps an empty site plan renderable at its complete planning extent", () => {
  const plan = planRoadsAndBuildings([], [], {
    meshWidth: 12,
    meshDepth: 8,
    metersPerUnit: 1,
  });
  assert.deepEqual(plan.bounds, { minX: -6, maxX: 6, minZ: -4, maxZ: 4 });
  const svg = renderRoadAndBuildingPlanSvg(plan, { showCenterlines: false });
  assert.match(svg, /aria-label="Road and building plan"/);
  assert.doesNotMatch(svg, /data-kind=/);
});
