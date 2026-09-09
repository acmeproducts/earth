import assert from "node:assert/strict";
import test from "node:test";
import { isSurfaceWaterFeature } from "../src/WaterFeatureVisibility.ts";

// Properties observed in OpenFreeMap z14/8681/4766 (central Oslo), 2026-09-09.
test("hides Oslo's underground Akerselva, Alna and Hovinbekken waterways", () => {
  for (const [id, name, waterClass] of [
    [644951252, "Akerselva", "river"],
    [1301060852, "Alna", "river"],
    [14549241742, "Hovinbekken", "stream"],
    [15366308862, "Akerselvakulverten", "river"],
  ]) {
    assert.equal(isSurfaceWaterFeature({
      intermittent: 0, brunnel: "tunnel", name, class: waterClass,
    }), false, `${name} (${id})`);
    assert.equal(isSurfaceWaterFeature({ intermittent: 0, name, class: waterClass }), true);
  }
});

test("recognizes culverts, covered water, negative layers and explicit underground locations", () => {
  for (const tags of [
    { tunnel: "culvert" }, { tunnel: "yes" }, { tunnel: true },
    { covered: "yes" }, { covered: 1 }, { location: "underground" },
    { layer: -1 }, { layer: "-2" }, { brunnel: " Tunnel " },
    { intermittent: 1 }, { intermittent: "yes" },
  ]) assert.equal(isSurfaceWaterFeature(tags), false, JSON.stringify(tags));
});

test("retains ordinary surface water and explicit false tags", () => {
  assert.equal(isSurfaceWaterFeature({}), true);
  assert.equal(isSurfaceWaterFeature({
    intermittent: 0, tunnel: "no", covered: "false", layer: "0", location: "surface",
  }), true);
});
