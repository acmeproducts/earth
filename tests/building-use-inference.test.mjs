import assert from "node:assert/strict";
import test from "node:test";
import { inferBuildingUse } from "../src/BuildingUseInference.ts";
import { planBuilding } from "../src/BuildingPlanner.ts";

const rectangle = (a, b, c, d) => ({ outer: [[a, b], [c, b], [c, d], [a, d], [a, b]], holes: [] });
const building = (properties = { class: "yes" }) => ({ id: "test", polygon: rectangle(0, 0, 10, 10), properties });
const point = (properties, position = [5, 5]) => ({ position, properties });
const infer = (source, points = [], areas = []) => planBuilding(inferBuildingUse(source, { points, areas }));

test("contained POI subclasses select non-residential interiors and matching profiles", () => {
  for (const [subclass, use, category] of [["hotel", "hotel", "commercial"], ["supermarket", "shop", "commercial"],
    ["school", "education", "education"], ["clinic", "medical", "medical"], ["warehouse", "warehouse", "warehouse"]]) {
    const plan = infer(building(), [point({ class: "service", subclass })]);
    assert.equal(plan.interiorUse, use);
    assert.equal(plan.buildingClass, category);
    assert.equal(plan.interiorUseSource, "poi");
  }
});

test("businesses outside the footprint or in a courtyard do not classify a building", () => {
  const source = building();
  source.polygon.holes = [rectangle(4, 4, 6, 6).outer];
  assert.equal(infer(source, [point({ shop: "clothes" }), point({ office: "company" }, [11, 5])]).interiorUse, undefined);
});

test("explicit use wins and residential business POIs produce mixed floors", () => {
  assert.equal(infer(building({ building: "school" }), [point({ shop: "books" })]).interiorUse, "education");
  const mixed = infer(building({ class: "apartments" }), [point({ shop: "clothes" })]);
  assert.equal(mixed.interiorUse, "residential");
  assert.equal(mixed.groundFloorUse, "shop");
  assert.equal(mixed.buildingClass, "residential");
  assert.equal(infer(building({ building: "church" }), [point({ shop: "books" })]).interiorUse, undefined);
});

test("conflicting business types stay unresolved regardless of feature order", () => {
  const points = [point({ shop: "books" }), point({ office: "company" })];
  assert.equal(infer(building(), points).interiorUse, undefined);
  assert.deepEqual(infer(building(), points), infer(building(), [...points].reverse()));
});

test("enclosing land use supplies a lower-priority prediction with the correct open-floor profile", () => {
  const areas = [{ polygon: rectangle(-1, -1, 11, 11), properties: { class: "industrial" } }];
  const plan = infer(building(), [], areas);
  assert.equal(plan.interiorUse, "industrial");
  assert.equal(plan.buildingClass, "industrial");
  assert.equal(plan.interiorUseSource, "landuse");
  assert.equal(infer(building(), [point({ office: "company" })], areas).interiorUse, "office");
  assert.equal(infer(building({ class: "apartments" }), [], areas).interiorUse, "residential");
  assert.equal(infer(building(), [], [{ ...areas[0], polygon: rectangle(-1, -1, 5, 11) }]).interiorUse, undefined);
});

test("missing or ambiguous land-use data preserves the existing fallback", () => {
  assert.equal(infer(building()).interiorUse, undefined);
  const polygon = rectangle(-1, -1, 11, 11);
  assert.equal(infer(building(), [], [{ polygon, properties: { class: "industrial" } },
    { polygon, properties: { class: "residential" } }]).interiorUse, undefined);
});
