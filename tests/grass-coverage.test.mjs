import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const fieldSource = readFileSync(new URL("../src/GrassField.ts", import.meta.url), "utf8");

test("mature grass covers every placement cell", () => {
  assert.match(fieldSource, /GRASS_SPACING_METERS = 1\.3/);
  assert.match(fieldSource, /\[LandCoverClass\.Grassland\]: 1,/);
  assert.match(fieldSource, /\[LandCoverClass\.Cropland\]: 1,/);
});

test("grass clumps overlap without strongly jittered bare gaps", () => {
  assert.match(fieldSource, /column \+ 0\.35 \+ random\(\) \* 0\.3/);
  assert.match(fieldSource, /row \+ 0\.35 \+ random\(\) \* 0\.3/);
  assert.match(fieldSource, /GRASS_WIDTH_SCALE_MINIMUM = 1\.1/);
  assert.match(fieldSource, /GRASS_WIDTH_SCALE_SPAN = 0\.42/);
  assert.match(
    fieldSource,
    /widthScale = GRASS_WIDTH_SCALE_MINIMUM \+ random\(\) \* GRASS_WIDTH_SCALE_SPAN/,
  );
});
