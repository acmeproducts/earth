import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ClockSettingsStore } from "../src/ClockSettings.ts";

const source = readFileSync(new URL("../src/ClockSettings.ts", import.meta.url), "utf8");
const controls = readFileSync(new URL("../src/SceneControls.ts", import.meta.url), "utf8");
const game = readFileSync(new URL("../src/Game.ts", import.meta.url), "utf8");

test("defaults use today's real date and manual choices survive switching modes", (t) => {
  t.mock.method(Date, "now", () => new Date(2026, 8, 6, 14, 30).getTime());
  let saved;
  const storage = { getItem: () => saved, setItem: (_key, value) => { saved = value; } };
  const store = new ClockSettingsStore(new URLSearchParams(), storage);
  assert.deepEqual(store.value, {
    mode: "automatic", manualDate: "2026-09-06", manualTimeOfDay: 14.5,
  });
  store.setMode("manual");
  store.setManualDate("2026-12-25");
  store.setManualTimeOfDay(18.5);
  const restored = new ClockSettingsStore(new URLSearchParams(), storage);
  assert.deepEqual(restored.value, store.value);
  restored.setMode("automatic");
  assert.deepEqual(restored.value, {
    mode: "automatic", manualDate: "2026-12-25", manualTimeOfDay: 18.5,
  });
});

test("clock settings default to automatic and retain manual values", () => {
  assert.match(source, /mode: "automatic"/);
  assert.match(source, /manualDate: formatCalendarDate\(now\)/);
  assert.match(source, /manualTimeOfDay: normalizeTime/);
  assert.match(source, /setMode\(mode: ClockMode\)/);
  assert.match(source, /this\.current = \{ \.\.\.this\.current, mode \}/);
});

test("manual date and time are validated, normalized, and persisted", () => {
  assert.match(source, /setManualDate\(date: string\)[\s\S]*?parseCalendarDate\(date\)/);
  assert.match(source, /setManualTimeOfDay\(hours: number\)[\s\S]*?normalizeTime\(hours\)/);
  assert.match(source, /storage\?\.setItem\(STORAGE_KEY, JSON\.stringify\(this\.current\)\)/);
  assert.match(source, /Math\.round\(finite \/ TIME_STEP_HOURS\)/);
});

test("URL date and time overrides select manual mode", () => {
  assert.match(source, /query\.get\("date"\)[\s\S]*?mode: "manual"/);
  assert.match(source, /query\.get\("time"\)[\s\S]*?mode: "manual"/);
  assert.match(source, /query\.get\("clock"\)/);
});

test("one toggle controls both date and time inputs", () => {
  assert.match(controls, /this\.manualClockInput\.type = "checkbox"/);
  assert.match(controls, /this\.dateInput\.disabled = this\.isAutomaticClock/);
  assert.match(controls, /this\.timeInput\.disabled = this\.isAutomaticClock/);
  assert.match(controls, /this\.manualDate = options\.clockSettings\.manualDate/);
  assert.match(controls, /this\.manualTimeOfDay = options\.clockSettings\.manualTimeOfDay/);
  assert.match(game, /createBrowserClockSettingsStore\(query\)/);
});
