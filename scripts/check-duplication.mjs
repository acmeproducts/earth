import { mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Initial ceiling after the cleanup. PRs use the target branch's artifact baseline.
const threshold = process.argv[2] ?? "7452";
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

const result = spawnSync(process.env.PYTHON ?? "python", [
  fileURLToPath(checker),
  "src",
  threshold,
  "node_modules/*,dist/*,.yarn/*,*.test.*,*.spec.*",
], { cwd: fileURLToPath(root), stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
