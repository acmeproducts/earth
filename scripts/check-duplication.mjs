import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Baselines are for report comparisons, never permission to reintroduce duplicates.
const threshold = process.argv[2] ?? "0";
if (!/^\d+$/.test(threshold)) {
  throw new Error("Usage: yarn check:duplication [nonnegative severity threshold]");
}

const root = new URL("../", import.meta.url);
const directory = new URL(".cache/duplication/", root);
const checker = new URL("duplicateCodeChecker3.py", directory);
const response = await fetch(
  "https://bitbucket.org/futureuniverse/repostaticanalysis/raw/main/duplicateCodeChecker3.py",
  { signal: AbortSignal.timeout(30_000) },
);
if (!response.ok) throw new Error(`Could not download duplicate code checker: HTTP ${response.status}`);
await mkdir(directory, { recursive: true });
await writeFile(checker, await response.text());
const resultsFile = new URL("duplicated_segments.json", root);
await rm(resultsFile, { force: true });

const result = spawnSync(process.env.PYTHON ?? "python", [
  fileURLToPath(checker),
  "src",
  threshold,
  "node_modules/*,dist/*,.yarn/*,*.test.*,*.spec.*",
], { cwd: fileURLToPath(root), stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
if (process.exitCode === 0) {
  // The upstream checker can override its threshold with previous_severity.txt.
  // Enforce the requested ceiling independently, using only this run's output.
  const results = JSON.parse(await readFile(resultsFile, "utf8"));
  if (typeof results.total_severity !== "number" || !Number.isFinite(results.total_severity) ||
      results.total_severity < 0) {
    throw new Error("Duplicate code checker returned an invalid severity");
  }
  if (results.total_severity > Number(threshold)) {
    console.error(`Duplication severity ${results.total_severity} exceeds ceiling ${threshold}`);
    process.exitCode = 1;
  }
}
