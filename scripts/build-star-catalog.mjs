import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_REVISION = "36b238ffb1964c858b419130e67858ad9adbd24e";
const SOURCE_ROOT = `https://raw.githubusercontent.com/frostoven/BSC5P-JSON-XYZ/${SOURCE_REVISION}/catalogs`;
const OUTPUT_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/sky/star-catalog.json",
);

const [positionsResponse, photometryResponse] = await Promise.all([
  fetch(`${SOURCE_ROOT}/bsc5p_radec_min.json`),
  fetch(`${SOURCE_ROOT}/bsc5p_spectral_extra_min.json`),
]);
if (!positionsResponse.ok || !photometryResponse.ok) {
  throw new Error(
    `Could not download the star catalogue (${positionsResponse.status}, ${photometryResponse.status})`,
  );
}

const positions = await positionsResponse.json();
const photometry = await photometryResponse.json();
const photometryById = new Map(photometry.map((entry) => [entry.i, entry]));
const catalog = {
  sourceRevision: SOURCE_REVISION,
  positions: [],
  magnitudes: [],
  colors: [],
};

for (const star of positions) {
  const details = photometryById.get(star.i);
  if (!details || !Number.isFinite(star.r) || !Number.isFinite(star.d) ||
      !Number.isFinite(details.b) || !star.K) {
    continue;
  }

  const cosDeclination = Math.cos(star.d);
  catalog.positions.push(
    rounded(cosDeclination * Math.cos(star.r), 7),
    rounded(cosDeclination * Math.sin(star.r), 7),
    rounded(Math.sin(star.d), 7),
  );
  catalog.magnitudes.push(rounded(details.b, 2));
  catalog.colors.push(
    rounded(star.K.r, 3),
    rounded(star.K.g, 3),
    rounded(star.K.b, 3),
  );
}

await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
await writeFile(OUTPUT_PATH, `${JSON.stringify(catalog)}\n`);
console.log(`Wrote ${catalog.magnitudes.length} stars to ${OUTPUT_PATH}`);

function rounded(value, digits) {
  return Number(value.toFixed(digits));
}
