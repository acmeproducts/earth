import assert from "node:assert/strict";
import test from "node:test";

import {
  formatCalendarDate,
  parseCalendarDate,
} from "../src/core/CalendarDate.ts";

test("parses valid local calendar dates", () => {
  assert.deepEqual(parseCalendarDate("2024-02-29"), {
    year: 2024,
    month: 2,
    day: 29,
  });
});

test("rejects malformed and impossible calendar dates", () => {
  assert.equal(parseCalendarDate("2026-2-03"), undefined);
  assert.equal(parseCalendarDate("2025-02-29"), undefined);
  assert.equal(parseCalendarDate("2026-13-01"), undefined);
});

test("formats dates without converting them to UTC", () => {
  const date = new Date(2026, 7, 23, 23, 45);
  assert.equal(formatCalendarDate(date), "2026-08-23");
});
