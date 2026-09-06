import assert from "node:assert/strict";
import test from "node:test";
import { getGameDate } from "../src/GameTime.ts";

const GAME_TIME_EPOCH = new Date(2026, 0, 1).getTime();

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

test("game time advances at real clock speed", () => {
  assert.equal(
    localClockMilliseconds(getGameDate(GAME_TIME_EPOCH + MINUTE_MILLISECONDS)),
    Date.UTC(2026, 0, 1, 0, 1),
  );
});

test("one real hour advances game time by one hour", () => {
  assert.equal(
    localClockMilliseconds(getGameDate(GAME_TIME_EPOCH + HOUR_MILLISECONDS)),
    Date.UTC(2026, 0, 1, 1),
  );
});

test("automatic time reads the current system clock on every call", (t) => {
  let now = new Date(2026, 11, 31, 23, 59, 59, 999).getTime();
  t.mock.method(Date, "now", () => now);
  assert.equal(getGameDate().getTime(), now);
  now += 86400000;
  assert.equal(getGameDate().getTime(), now);
});
