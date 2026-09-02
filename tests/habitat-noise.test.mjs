import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { register } from "node:module";
import test from "node:test";

register("./ts-extension-resolver.mjs", import.meta.url);
const { habitatField } = await import("../src/HabitatNoise.ts");

const WORLD_SEED = 0x45415254;
const BUSHES = {
  patchMeters: 90,
  abundanceMeters: 2400,
  barrenShare: 0.28,
  richestCoverage: 0.92,
};

const METERS_PER_DEGREE = 111_320;
const LATITUDE = 47.3;
const LONGITUDE = 8.5;

/** Walks a grid of ground metres and reports the strength at each point. */
function scan(field, { spanMeters, step }) {
  const perDegreeLongitude = METERS_PER_DEGREE * Math.cos(LATITUDE * Math.PI / 180);
  const steps = Math.round(spanMeters / step);
  const values = [];
  for (let i = 0; i < steps; i++) {
    for (let j = 0; j < steps; j++) {
      values.push(field.sample(
        LONGITUDE + (i * step) / perDegreeLongitude,
        LATITUDE + (j * step) / METERS_PER_DEGREE,
      ));
    }
  }
  return { values, steps };
}

test("coverage matches the requested share of the ground", () => {
  // The abundance field is a smoothstep of a uniform variable, so its mean is
  // half the non-barren share. If the noise were used raw, the bell-shaped
  // simplex distribution would make these settings mean nothing in particular.
  for (const spec of [
    BUSHES,
    { patchMeters: 120, abundanceMeters: 3000, barrenShare: 0.45, richestCoverage: 0.9 },
    { patchMeters: 150, abundanceMeters: 2000, barrenShare: 0.34, richestCoverage: 0.95 },
  ]) {
    const field = habitatField(`coverage/${spec.barrenShare}`, WORLD_SEED, spec);
    const { values } = scan(field, { spanMeters: 24_000, step: 60 });
    const covered = values.filter((value) => value > 0).length / values.length;
    const expected = spec.richestCoverage * 0.5 * (1 - spec.barrenShare);
    assert.ok(
      Math.abs(covered - expected) < 0.04,
      `covered ${covered.toFixed(3)}, expected about ${expected.toFixed(3)}`,
    );
  }
});

test("rarity varies district to district instead of being uniform", () => {
  const field = habitatField("contrast", WORLD_SEED, BUSHES);
  const step = 75;
  const districtSteps = 8; // 600 m, roughly what is visible at once
  const districts = 40;
  const perDegreeLongitude = METERS_PER_DEGREE * Math.cos(LATITUDE * Math.PI / 180);
  const covered = [];
  for (let districtX = 0; districtX < districts; districtX++) {
    for (let districtY = 0; districtY < districts; districtY++) {
      let present = 0;
      for (let i = 0; i < districtSteps; i++) {
        for (let j = 0; j < districtSteps; j++) {
          const x = (districtX * districtSteps + i) * step;
          const y = (districtY * districtSteps + j) * step;
          if (field.sample(
            LONGITUDE + x / perDegreeLongitude,
            LATITUDE + y / METERS_PER_DEGREE,
          ) > 0) present++;
        }
      }
      covered.push(present / (districtSteps * districtSteps));
    }
  }
  covered.sort((left, right) => left - right);
  const quantile = (share) => covered[Math.floor(share * (covered.length - 1))];

  // A single-threshold field would put every district near the global mean.
  // These bounds only hold because abundance varies underneath the patches.
  assert.ok(quantile(0.1) < 0.05, `p10 coverage ${quantile(0.1).toFixed(3)}`);
  assert.ok(quantile(0.9) > 0.55, `p90 coverage ${quantile(0.9).toFixed(3)}`);
  const empty = covered.filter((value) => value < 0.02).length / covered.length;
  assert.ok(empty > 0.1, `only ${(empty * 100).toFixed(1)}% of districts are empty`);
});

test("stands are continuous, so they survive a tile boundary", () => {
  const field = habitatField("continuity", WORLD_SEED, BUSHES);
  const perDegreeLongitude = METERS_PER_DEGREE * Math.cos(LATITUDE * Math.PI / 180);
  // Stand edges are deliberately crisp: the fade spans a narrow band of a
  // thirty-metre octave, so the field moves fast over a metre by design. The
  // step here is small enough that even the steepest edge stays gradual, which
  // leaves a tile seam — a jump of half the range or more — the only thing
  // that can fail this.
  const step = 0.05;
  let largestStep = 0;
  let previous = field.sample(LONGITUDE, LATITUDE);
  for (let meters = step; meters <= 400; meters += step) {
    const value = field.sample(LONGITUDE + meters / perDegreeLongitude, LATITUDE);
    largestStep = Math.max(largestStep, Math.abs(value - previous));
    previous = value;
  }
  assert.ok(largestStep < 0.1, `largest step ${largestStep.toFixed(3)}`);
});

test("a field is stable within a world and differs between worlds", () => {
  const spec = BUSHES;
  const first = habitatField("stability", WORLD_SEED, spec);
  const again = habitatField("stability", WORLD_SEED, spec);
  const elsewhere = habitatField("stability", WORLD_SEED ^ 0x1234, spec);
  assert.equal(first, again);

  const { values } = scan(first, { spanMeters: 4_000, step: 40 });
  const other = scan(elsewhere, { spanMeters: 4_000, step: 40 }).values;
  assert.deepEqual(scan(again, { spanMeters: 4_000, step: 40 }).values, values);
  const differing = values.filter((value, index) => value !== other[index]).length;
  assert.ok(differing > values.length * 0.3, `${differing} of ${values.length} differ`);
});

test("the barren share and richest coverage bound the field", () => {
  const everywhere = habitatField("everywhere", WORLD_SEED, {
    ...BUSHES,
    barrenShare: 0,
    richestCoverage: 1,
  });
  const nowhere = habitatField("nowhere", WORLD_SEED, {
    ...BUSHES,
    richestCoverage: 0,
  });
  const dense = scan(everywhere, { spanMeters: 6_000, step: 40 }).values;
  assert.ok(dense.filter((value) => value > 0).length / dense.length > 0.45);
  assert.ok(dense.every((value) => value <= 1));
  assert.ok(scan(nowhere, { spanMeters: 6_000, step: 40 }).values.every((v) => v === 0));
});

test("no scattered layer seeds a spatial field from its per-tile stream", () => {
  // `seed` is the per-tile placement stream in every *Field module; world-level
  // fields take `modelVariantSeed`/`speciesSeed`. Seeding noise from the tile
  // seed reseeds and rephases the pattern at every tile edge, which is the
  // visible seam this whole module exists to avoid — so it must stay absent.
  const fields = readdirSync(new URL("../src/", import.meta.url))
    .filter((name) => name.endsWith("Field.ts"));
  assert.ok(fields.length >= 8, `expected the field modules, found ${fields}`);
  for (const name of fields) {
    const source = readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");
    assert.doesNotMatch(
      source,
      /new SimplexNoise2D\(\s*seed\b/,
      `${name} seeds a spatial noise field from its per-tile seed`,
    );
  }
});
