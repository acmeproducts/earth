export interface SceneSettings {
  modelRangeMeters: number;
  detailTilesAcross: number;
  terrainTilesAcross: number;
  cloudDensity: number;
  windSpeedMetersPerSecond: number;
  showRoofs: boolean;
}

export type SceneSettingKey = Exclude<keyof SceneSettings, "showRoofs">;

export interface SceneSettingDefinition<K extends SceneSettingKey = SceneSettingKey> {
  key: K;
  label: string;
  ariaLabel: string;
  queryParameter: string;
  minimum: number;
  maximum: number;
  step: number;
  defaultValue: number;
  format: (value: number) => string;
}

export const SCENE_SETTING_DEFINITIONS: readonly SceneSettingDefinition[] = [
  {
    key: "modelRangeMeters",
    label: "Model range",
    ariaLabel: "Real model range in meters",
    queryParameter: "vegetation-distance",
    minimum: 0,
    maximum: 200,
    step: 1,
    defaultValue: 50,
    format: (value) => `${value} m`,
  },
  {
    key: "detailTilesAcross",
    label: "Full detail",
    ariaLabel: "Fully detailed terrain size in tiles",
    queryParameter: "detail-size",
    minimum: 1,
    maximum: 9,
    step: 1,
    defaultValue: 3,
    format: formatTileArea,
  },
  {
    key: "terrainTilesAcross",
    label: "Far terrain",
    ariaLabel: "Far terrain size in tiles",
    queryParameter: "terrain-size",
    minimum: 3,
    maximum: 25,
    step: 2,
    defaultValue: 17,
    format: formatTileArea,
  },
  {
    key: "cloudDensity",
    label: "Cloud density",
    ariaLabel: "Cloud density from zero to one",
    queryParameter: "cloud-density",
    minimum: 0,
    maximum: 1,
    step: 0.05,
    defaultValue: 0.65,
    format: (value) => value.toFixed(2),
  },
  {
    key: "windSpeedMetersPerSecond",
    label: "Wind speed",
    ariaLabel: "Manual wind speed in meters per second",
    queryParameter: "wind-speed",
    minimum: 0,
    maximum: 30,
    step: 1,
    defaultValue: 14,
    format: (value) => `${value} m/s`,
  },
] as const;

export const DEFAULT_SCENE_SETTINGS = settingsFromDefinitions();

const STORAGE_KEY = "earth.scene-settings.v1";

type SettingsStorage = Pick<Storage, "getItem" | "setItem">;

/** Owns normalized scene settings and persists every runtime change. */
export class SceneSettingsStore {
  private current: SceneSettings;
  private readonly storage?: SettingsStorage;

  constructor(
    query: URLSearchParams,
    storage?: SettingsStorage,
  ) {
    this.storage = storage;
    this.current = loadSceneSettings(query, storage);
  }

  get value(): Readonly<SceneSettings> {
    return this.current;
  }

  update(key: SceneSettingKey, value: number): Readonly<SceneSettings> {
    this.current = updateSceneSetting(this.current, key, value);
    this.persist();
    return this.current;
  }

  setRoofsVisible(value: boolean): Readonly<SceneSettings> {
    this.current = { ...this.current, showRoofs: value };
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

export function createBrowserSceneSettingsStore(query: URLSearchParams): SceneSettingsStore {
  let storage: Storage | undefined;
  try {
    storage = window.localStorage;
  } catch {
    storage = undefined;
  }
  return new SceneSettingsStore(query, storage);
}

export function updateSceneSetting(
  current: Readonly<SceneSettings>,
  key: SceneSettingKey,
  value: number,
): SceneSettings {
  const next = { ...current, [key]: normalizeSettingValue(key, value) };
  if (key === "detailTilesAcross" && next.detailTilesAcross > next.terrainTilesAcross) {
    next.terrainTilesAcross = next.detailTilesAcross;
  } else if (key === "terrainTilesAcross" && next.terrainTilesAcross < next.detailTilesAcross) {
    next.detailTilesAcross = next.terrainTilesAcross;
  }
  return next;
}

function loadSceneSettings(
  query: URLSearchParams,
  storage?: SettingsStorage,
): SceneSettings {
  let settings = DEFAULT_SCENE_SETTINGS;
  try {
    const stored = storage?.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      settings = normalizeSettings({ ...settings, ...parsed });
      settings.showRoofs = parsed.showRoofs !== false;
    }
  } catch {
    // Ignore malformed or inaccessible storage and retain safe defaults.
  }

  for (const definition of SCENE_SETTING_DEFINITIONS) {
    const requested = query.get(definition.queryParameter);
    if (requested === null) continue;
    const value = Number(requested);
    if (Number.isFinite(value)) settings = updateSceneSetting(settings, definition.key, value);
  }
  const requestedRoofs = query.get("roofs");
  if (requestedRoofs !== null) settings.showRoofs = !["0", "off", "false"].includes(requestedRoofs.toLowerCase());
  return settings;
}

function normalizeSettings(candidate: Partial<SceneSettings>): SceneSettings {
  const settings = settingsFromDefinitions(candidate);
  settings.terrainTilesAcross = Math.max(
    settings.detailTilesAcross,
    settings.terrainTilesAcross,
  );
  return settings;
}

function settingsFromDefinitions(candidate: Partial<SceneSettings> = {}): SceneSettings {
  const settings = {} as SceneSettings;
  for (const definition of SCENE_SETTING_DEFINITIONS) {
    settings[definition.key] = normalizeValue(
      candidate[definition.key] ?? definition.defaultValue,
      definition,
    );
  }
  settings.showRoofs = candidate.showRoofs ?? true;
  return settings;
}

function normalizeSettingValue(key: SceneSettingKey, value: number): number {
  const definition = SCENE_SETTING_DEFINITIONS.find((item) => item.key === key);
  if (!definition) return value;
  return normalizeValue(value, definition);
}

function normalizeValue(value: number, definition: SceneSettingDefinition): number {
  const finiteValue = Number.isFinite(value) ? value : definition.defaultValue;
  const steps = Math.round((finiteValue - definition.minimum) / definition.step);
  const stepped = definition.minimum + steps * definition.step;
  const clamped = Math.max(definition.minimum, Math.min(definition.maximum, stepped));
  return Number(clamped.toFixed(10));
}

function formatTileArea(tilesAcross: number): string {
  return `${tilesAcross} x ${tilesAcross}`;
}
