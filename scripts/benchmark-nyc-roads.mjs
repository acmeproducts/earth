// yarn node --import ./tests/register-typescript.mjs scripts/benchmark-nyc-roads.mjs
import { readFileSync } from 'node:fs';
import { runRoadPlanningTask } from '../src/roads/RoadPlanningTask.ts';

const input = JSON.parse(readFileSync(new URL('../tests/fixtures/nyc-road-planning.json', import.meta.url)));
for (let sample = 0; sample < 4; sample++) {
  const result = runRoadPlanningTask(input);
  console.log(JSON.stringify({ sample, polygons: result.plan.roads.length, timings: result.timings }));
}
