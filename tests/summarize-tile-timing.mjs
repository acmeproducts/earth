// Prints the tile timing summaries written by drive-tile-timing.mjs.
//   yarn node tests/summarize-tile-timing.mjs <label-or-file> [<label-or-file> ...]
// A label picks the newest artifacts/tile-timing/<label>-*.json file.
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const directory = resolve('artifacts', 'tile-timing');
const pad = (value, width) => String(value).padStart(width);

function load(selector) {
  if (selector.endsWith('.json')) return JSON.parse(readFileSync(selector, 'utf8'));
  const file = readdirSync(directory).filter((n) => n.startsWith(`${selector}-`)).sort().at(-1);
  if (!file) throw new Error(`No artifact for label ${selector}`);
  return JSON.parse(readFileSync(join(directory, file), 'utf8'));
}

function aggregateNested(recentStages, prefix) {
  const rows = new Map();
  for (const stage of recentStages ?? []) {
    if (!stage.label.startsWith(prefix) || stage.executionThread !== 'main') continue;
    const key = stage.stage.replace(/\d+/g, '*');
    const row = rows.get(key) ?? { stage: key, count: 0, totalMs: 0, maxMs: 0 };
    row.count++;
    row.totalMs += stage.durationMilliseconds;
    row.maxMs = Math.max(row.maxMs, stage.durationMilliseconds);
    rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) => b.totalMs - a.totalMs);
}

for (const selector of process.argv.slice(2)) {
  const run = load(selector);
  console.log(`\n=== ${run.label}  (init ${run.initializationSeconds?.toFixed?.(1)} s, ${run.errors.length} errors)`);
  if (run.frames) {
    const f = run.frames;
    console.log(`frames: interval ${f.averageIntervalMs.toFixed(1)} ms, game ${f.averageGameMs.toFixed(1)} ms, render ${f.averageRenderMs.toFixed(1)} ms, `
      + `interval estimate ${f.frameIntervalEstimateMs?.toFixed?.(1)} ms, callback estimate ${f.frameCallbackEstimateMs?.toFixed?.(1)} ms, `
      + `streaming budget now ${f.streamingBudgetMs?.toFixed?.(2)} ms`);
  }
  for (const row of run.summary.tiles) {
    console.log(`${pad(row.kind, 8)} tiles ${pad(row.tiles, 4)}  avg total ${pad(row.averageTotalMs.toFixed(0), 6)} ms`
      + `  max ${pad(row.maxTotalMs.toFixed(0), 6)}  avg blocking ${pad(row.averageBlockingMs.toFixed(1), 6)}  max blocking ${pad(row.maxBlockingMs.toFixed(0), 5)}`);
  }
  const print = (title, rows, limit) => {
    console.log(`-- ${title}`);
    console.log(`${pad('total', 8)} ${pad('n', 5)} ${pad('avg', 8)} ${pad('max', 7)}  stage`);
    for (const s of rows.slice(0, limit)) {
      console.log(`${pad(s.totalMs.toFixed(0), 8)} ${pad(s.tiles ?? s.count, 5)} ${pad((s.averageMs ?? s.totalMs / s.count).toFixed(1), 8)} ${pad(s.maxMs.toFixed(0), 7)}  ${s.stage}`);
    }
  };
  const stages = run.summary.stages;
  print('wall-clock stages', stages.filter((s) => s.kind === 'wall-clock'), 22);
  print('blocking stages', stages.filter((s) => s.kind === 'blocking'), 10);
  print('worker stages', stages.filter((s) => s.kind === 'worker'), 16);
  const nested = stages.filter((s) => s.kind === 'nested');
  if (nested.length) print('nested tree field stages', nested, 12);
  else print('recent tree field stages (last 2048 records only)', aggregateNested(run.recentStages, 'trees '), 10);
}
