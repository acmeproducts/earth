import assert from "node:assert/strict";
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

async function runGate(t, severity, { writeOutput = true, exitCode = 0 } = {}) {
  const root = await mkdtemp(join(tmpdir(), "earth-duplication-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "scripts"));
  await copyFile(new URL("../scripts/check-duplication.mjs", import.meta.url), join(root, "scripts/check-duplication.mjs"));
  await writeFile(join(root, "previous_severity.txt"), "7452\n@@@\n16");
  await writeFile(join(root, "duplicated_segments.json"), JSON.stringify({ total_severity: 0 }));
  // Substitute only the external checker: simulate its baseline override and exit status.
  const checker = `${writeOutput ? `require('node:fs').writeFileSync('duplicated_segments.json', ${JSON.stringify(JSON.stringify({ total_severity: severity }))});` : ""}process.exit(${exitCode});`;
  const preload = join(root, "fetch.mjs");
  await writeFile(preload, `globalThis.fetch = async () => new Response(${JSON.stringify(checker)});`);
  const result = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, join(root, "scripts/check-duplication.mjs")], {
    cwd: root, env: { ...process.env, NODE_OPTIONS: "", PYTHON: process.execPath }, encoding: "utf8",
  });
  assert.ifError(result.error);
  return result;
}

test("zero duplication passes the default CI gate", async t => {
  const result = await runGate(t, 0);
  assert.equal(result.status, 0, result.stderr);
});

test("an older positive baseline cannot relax the zero-duplication gate", async t => {
  const result = await runGate(t, 1);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /exceeds ceiling 0/);
});

test("missing or invalid checker output fails closed instead of reusing a stale report", async t => {
  assert.notEqual((await runGate(t, 0, { writeOutput: false })).status, 0);
  assert.notEqual((await runGate(t, "0")).status, 0);
});

test("checker failures propagate and CI explicitly requests the zero ceiling", async t => {
  assert.equal((await runGate(t, 0, { exitCode: 2 })).status, 2);
  const workflow = await readFile(new URL("../.github/workflows/duplication-check.yml", import.meta.url), "utf8");
  assert.match(workflow, /run: node scripts\/check-duplication\.mjs 0/);
  assert.doesNotMatch(workflow, /mv duplication_severity\.txt previous_severity\.txt/);
});
