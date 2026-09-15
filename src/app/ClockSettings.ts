import { formatCalendarDate, parseCalendarDate } from "../core/CalendarDate";
import { getGameDate } from "../core/GameTime";

export type ClockMode = "automatic" | "manual";

export interface ClockSettings {
  mode: ClockMode;
  manualDate: string;
  manualTimeOfDay: number;
}

const STORAGE_KEY = "earth.clock-settings.v1";
const TIME_STEP_HOURS = 0.25;
type SettingsStorage = Pick<Storage, "getItem" | "setItem">;

/** Persists clock mode and the manual values independently of scene rendering settings. */
export class ClockSettingsStore {
  private current: ClockSettings;
  private readonly storage?: SettingsStorage;

  constructor(
    query: URLSearchParams,
    storage?: SettingsStorage,
    now = getGameDate(),
  ) {
    this.storage = storage;
    this.current = loadClockSettings(query, storage, now);
  }

  get value(): Readonly<ClockSettings> {
    return this.current;
  }

  setMode(mode: ClockMode): Readonly<ClockSettings> {
    this.current = { ...this.current, mode };
    this.persist();
    return this.current;
  }

  setManualDate(date: string): Readonly<ClockSettings> {
    if (!parseCalendarDate(date)) return this.current;
    this.current = { ...this.current, manualDate: date };
    this.persist();
    return this.current;
  }

  setManualTimeOfDay(hours: number): Readonly<ClockSettings> {
    this.current = { ...this.current, manualTimeOfDay: normalizeTime(hours) };
    this.persist();
    return this.current;
  }

  private persist(): void {
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.current));
    } catch {
      // Storage may be unavailable in private or embedded browsing contexts.
    }
  }
}

export function createBrowserClockSettingsStore(query: URLSearchParams): ClockSettingsStore {
  let storage: Storage | undefined;
  try {
    storage = window.localStorage;
  } catch {
    storage = undefined;
  }
  return new ClockSettingsStore(query, storage);
}

function loadClockSettings(
  query: URLSearchParams,
  storage: SettingsStorage | undefined,
  now: Date,
): ClockSettings {
  const defaults: ClockSettings = {
    mode: "automatic",
    manualDate: formatCalendarDate(now),
    manualTimeOfDay: normalizeTime(now.getHours() + now.getMinutes() / 60),
  };
  let settings = defaults;
  try {
    const stored = storage?.getItem(STORAGE_KEY);
    if (stored) settings = normalizeClockSettings(JSON.parse(stored), defaults);
  } catch {
    // Ignore malformed or inaccessible storage and retain safe defaults.
  }

  const requestedDate = query.get("date");
  if (requestedDate && parseCalendarDate(requestedDate)) {
    settings = { ...settings, mode: "manual", manualDate: requestedDate };
  }
  const requestedTime = query.get("time");
  if (requestedTime !== null && Number.isFinite(Number(requestedTime))) {
    settings = {
      ...settings,
      mode: "manual",
      manualTimeOfDay: normalizeTime(Number(requestedTime)),
    };
  }
  const requestedMode = query.get("clock");
  if (requestedMode === "automatic" || requestedMode === "manual") {
    settings = { ...settings, mode: requestedMode };
  }
  return settings;
}

function normalizeClockSettings(
  candidate: Partial<ClockSettings>,
  defaults: ClockSettings,
): ClockSettings {
  return {
    mode: candidate.mode === "manual" || candidate.mode === "automatic"
      ? candidate.mode
      : defaults.mode,
    manualDate: typeof candidate.manualDate === "string" && parseCalendarDate(candidate.manualDate)
      ? candidate.manualDate
      : defaults.manualDate,
    manualTimeOfDay: normalizeTime(candidate.manualTimeOfDay ?? defaults.manualTimeOfDay),
  };
}

function normalizeTime(hours: number): number {
  const finite = Number.isFinite(hours) ? hours : 12;
  const stepped = Math.round(finite / TIME_STEP_HOURS) * TIME_STEP_HOURS;
  return Math.max(0, Math.min(24 - TIME_STEP_HOURS, stepped));
}
