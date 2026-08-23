import assert from "node:assert/strict";
import test from "node:test";
import {
  GAME_TIME_EPOCH,
  GAME_TIME_SPEED,
  getGameDate,
} from "../src/GameTime.ts";

const HOUR_MILLISECONDS = 60 * 60 * 1_000;
const MINUTE_MILLISECONDS = 60 * 1_000;

function localClockMilliseconds(date) {
  return Date.UTC(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
    date.getMilliseconds(),
  );
}

test("game time begins at midnight on 1 January 2026", () => {
  const date = getGameDate(GAME_TIME_EPOCH);

  assert.equal(date.getFullYear(), 2026);
  assert.equal(date.getMonth(), 0);
  assert.equal(date.getDate(), 1);
  assert.equal(date.getHours(), 0);
  assert.equal(date.getMinutes(), 0);
});

test("game time advances uniformly at 24x", () => {
  assert.equal(GAME_TIME_SPEED, 24);
  assert.equal(
    localClockMilliseconds(getGameDate(GAME_TIME_EPOCH + MINUTE_MILLISECONDS)),
    Date.UTC(2026, 0, 1, 0, 24),
  );
});

test("one real hour advances game time by one full day", () => {
  assert.equal(
    localClockMilliseconds(getGameDate(GAME_TIME_EPOCH + HOUR_MILLISECONDS)),
    Date.UTC(2026, 0, 2),
  );
});
