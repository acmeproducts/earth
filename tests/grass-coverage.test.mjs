import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const fieldSource = readFileSync(new URL("../src/GrassField.ts", import.meta.url), "utf8");

test("mature grass covers every placement cell", () => {
  assert.match(fieldSource, /GRASS_SPACING_METERS = 1\.3/);
  assert.match(fieldSource, /\[LandCoverClass\.Grassland\]: 1,/);
  assert.match(fieldSource, /\[LandCoverClass\.Cropland\]: 1,/);
});

test("grass clumps overlap with enough jitter to hide field boundaries", () => {
  assert.match(fieldSource, /column \+ 0\.18 \+ random\(\) \* 0\.64/);
  assert.match(fieldSource, /row \+ 0\.18 \+ random\(\) \* 0\.64/);
  assert.match(fieldSource, /GRASS_WIDTH_SCALE_MINIMUM = 1\.1/);
  assert.match(fieldSource, /GRASS_WIDTH_SCALE_SPAN = 0\.42/);
  assert.match(
    fieldSource,
    /widthScale = GRASS_WIDTH_SCALE_MINIMUM \+ random\(\) \* GRASS_WIDTH_SCALE_SPAN/,
  );
});

test("grass clump silhouettes taper through an irregular low fringe", () => {
  const impostorSource = readFileSync(
    new URL("../src/GrassImpostor.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    impostorSource,
    /CLUMP_EDGE_RADIUS_SCALE_MINIMUM \+ random\(\) \* CLUMP_EDGE_RADIUS_SCALE_SPAN/,
  );
  assert.match(
    impostorSource,
    /1 - 0\.46 \* Math\.pow\(radius \/ edgeRadius, 1\.6\)/,
  );
});
