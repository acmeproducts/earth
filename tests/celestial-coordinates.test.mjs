import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import {
  horizontalToSceneRotation,
  rotateJ2000Direction,
} from "../src/sky/CelestialCoordinates.ts";

const require = createRequire(import.meta.url);
const Astronomy = require("astronomy-engine");
const degrees = (value) => value * Math.PI / 180;

function rotationAt(date, latitude, longitude) {
  return horizontalToSceneRotation(
    Astronomy.Rotation_EQJ_HOR(
      date,
      new Astronomy.Observer(latitude, longitude, 0),
    ).rot,
  );
}

test("maps an equatorial direction onto the scene unit sphere", () => {
  const rotation = rotationAt(
    new Date("2026-08-22T22:00:00Z"),
    59.91,
    10.75,
  );
  const direction = rotateJ2000Direction(rotation, 0.3, 0.4, Math.sqrt(0.75));
  assert.ok(Math.abs(Math.hypot(direction.x, direction.y, direction.z) - 1) < 1e-12);
});

test("places the local meridian at the observer zenith", () => {
  const date = new Date("2026-08-22T22:00:00Z");
  const latitude = 37.5;
  const longitude = -122.2;
  const rightAscension = degrees((Astronomy.SiderealTime(date) + longitude / 15) * 15);
  const declination = degrees(latitude);
  const rotation = rotationAt(date, latitude, longitude);
  const direction = rotateJ2000Direction(
    rotation,
    Math.cos(declination) * Math.cos(rightAscension),
    Math.cos(declination) * Math.sin(rightAscension),
    Math.sin(declination),
  );

  // Precession and nutation move a J2000 direction slightly away from the
  // of-date zenith, but it must remain very close and above the observer.
  assert.ok(direction.y > 0.9999);
  assert.ok(Math.abs(direction.x) < 0.015);
  assert.ok(Math.abs(direction.z) < 0.015);
});

test("places Polaris above the northern horizon by roughly the latitude", () => {
  const latitude = 60;
  const rotation = rotationAt(
    new Date("2026-08-22T22:00:00Z"),
    latitude,
    10.75,
  );
  const ra = degrees(37.95456067);
  const dec = degrees(89.26410897);
  const direction = rotateJ2000Direction(
    rotation,
    Math.cos(dec) * Math.cos(ra),
    Math.cos(dec) * Math.sin(ra),
    Math.sin(dec),
  );
  const altitude = Math.asin(direction.y) * 180 / Math.PI;

  assert.ok(altitude > 59 && altitude < 61);
  assert.ok(direction.z > 0);
});
