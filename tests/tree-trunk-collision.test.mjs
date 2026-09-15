import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  resolveTreeTrunkCollisions,
  TREE_TRUNK_PROFILES,
  TreeTrunkIndex,
} from "../src/vegetation/TreeTrunkCollision.ts";

const SPECIES = [
  "acacia", "beech", "birch", "eucalyptus", "fir", "kapok", "mangrove",
  "maple", "oak", "palm", "pine", "spruce",
];

const body = (x, z, overrides = {}) => ({
  x,
  z,
  footY: 0,
  radius: 0.3,
  height: 1.8,
  ...overrides,
});

const trunk = (x, z, overrides = {}) => ({
  x,
  z,
  baseY: 0,
  radius: 0.5,
  height: 6,
  ...overrides,
});

test("every tree species has a trunk collision profile", () => {
  assert.deepEqual(Object.keys(TREE_TRUNK_PROFILES).sort(), SPECIES);
  for (const species of SPECIES) {
    const profile = TREE_TRUNK_PROFILES[species];
    assert.ok(profile.radius > 0 && profile.radius < 0.3, `${species} radius`);
    assert.ok(profile.heightFraction > 0 && profile.heightFraction <= 1, `${species} height`);
  }
});

test("a walker overlapping a stem is pushed out along the contact normal", () => {
  const result = resolveTreeTrunkCollisions(body(0.4, 0), [trunk(0, 0)]);
  assert.ok(result.blocked);
  assert.ok(Math.abs(result.x - 0.8) < 1e-9, `x ${result.x}`);
  assert.ok(Math.abs(result.z) < 1e-9);
});

test("a walker clear of every stem is left in place", () => {
  const result = resolveTreeTrunkCollisions(body(1.2, 0.5), [trunk(0, 0), trunk(3, 3)]);
  assert.equal(result.blocked, false);
  assert.equal(result.x, 1.2);
  assert.equal(result.z, 0.5);
});

test("a walker standing on the stem axis still gets a contact normal", () => {
  const result = resolveTreeTrunkCollisions(body(2, 2), [trunk(2, 2)]);
  assert.ok(result.blocked);
  assert.ok(Math.abs(Math.hypot(result.x - 2, result.z - 2) - 0.8) < 1e-9);
});

test("stems entirely above or below the walker's body do not block it", () => {
  const onRoof = resolveTreeTrunkCollisions(
    body(0.1, 0, { footY: 7 }),
    [trunk(0, 0, { baseY: 0, height: 6 })],
  );
  assert.equal(onRoof.blocked, false);

  const belowCliff = resolveTreeTrunkCollisions(
    body(0.1, 0, { footY: 0 }),
    [trunk(0, 0, { baseY: 2.5, height: 6 })],
  );
  assert.equal(belowCliff.blocked, false);

  const level = resolveTreeTrunkCollisions(
    body(0.1, 0, { footY: 0 }),
    [trunk(0, 0, { baseY: 1, height: 6 })],
  );
  assert.ok(level.blocked);
});

test("a walker wedged between two stems closer than its body is ejected sideways", () => {
  // Axes 1.4 apart with 0.8 contact distance each: the body cannot fit between.
  const trunks = [trunk(0, 0, { radius: 0.5 }), trunk(1.4, 0, { radius: 0.5 })];
  const result = resolveTreeTrunkCollisions(body(0.7, 0.05), trunks);
  assert.ok(result.blocked);
  assert.ok(result.z > 0.3, `ejected z ${result.z}`);
  for (const stem of trunks) {
    const distance = Math.hypot(result.x - stem.x, result.z - stem.z);
    assert.ok(distance >= 0.8 - 1e-3, `distance ${distance}`);
  }
});

test("the trunk index returns stems within reach across cell boundaries only", () => {
  const index = new TreeTrunkIndex(2);
  index.add(trunk(1.9, 0, { radius: 0.4 }));
  index.add(trunk(2.1, 0, { radius: 0.4 }));
  index.add(trunk(10, 10, { radius: 0.4 }));
  assert.equal(index.count, 3);

  // Reach is the body radius plus the widest stem: 0.7 from x = 1.5 spans
  // into the next cell and picks up both nearby stems.
  const near = index.nearby(1.5, 0, 0.3);
  assert.deepEqual(near.map((stem) => stem.x).sort(), [1.9, 2.1]);
  assert.deepEqual(index.nearby(6, 6, 0.3), []);
  assert.deepEqual(new TreeTrunkIndex(2).nearby(0, 0, 5), []);
});

test("the trunk index reach grows with its widest stem", () => {
  const index = new TreeTrunkIndex(4);
  index.add(trunk(3, 0, { radius: 1.5 }));
  assert.equal(index.nearby(1.2, 0, 0.3).length, 1);
  assert.equal(index.nearby(-1, 0, 0.3).length, 0);
});

test("tree placement records a scaled stem for every planted tree", () => {
  const treeField = readFileSync(new URL("../src/vegetation/TreeField.ts", import.meta.url), "utf8");
  assert.match(treeField, /new TreeTrunkIndex\(/);
  assert.match(treeField, /trunks\.add\(\{/);
  assert.match(treeField, /radius: trunkProfile\.radius \* modelScale \* widthScale/);
  assert.match(treeField, /result\.trunks = trunks/);

  const controls = readFileSync(new URL("../src/app/PlayerControls.ts", import.meta.url), "utf8");
  assert.match(controls, /this\.pushOutOfTreeTrunks\(metersPerUnit\)/);
});
