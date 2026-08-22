export const EXAMPLE_LOCATIONS = [
  {
    name: "Reso",
    lat: 58.79605454187253,
    lon: 11.182361556113896,
  },
  {
    name: "Storyodden",
    lat: 59.8888085995981,
    lon: 10.593090176648504,
  },
  {
    name: "Casa",
    lat: 59.904706664625266,
    lon: 10.61104958556299,
  },
  {
    name: "Fornebu",
    lat: 59.8833298,
    lon: 10.6166642,
  },
  {
    name: "Valserud",
    lat: 59.58990531228428,
    lon: 13.783101006047959,
  },
  {
    name: "Gaustatoppen",
    lat: 59.85373224178274,
    lon: 8.649698171043344,
  },
  {
    name: "New York",
    lat: 40.70562745934957,
    lon: -74.01329094009722,
  },
  {
    name: "Edsåsdalen",
    lat: 63.31740743074281,
    lon: 13.074744350282623,
  },
  {
    name: "Bangladesh",
    lat: 22.046490468966393,
    lon: 90.67841786422733,
  },
] as const;

export type ExampleLocation = (typeof EXAMPLE_LOCATIONS)[number];

export interface WorldLocation {
  lat: number;
  lon: number;
}

export const WEB_MERCATOR_MAX_LATITUDE = 85.05112878;
const WEB_MERCATOR_MAX_SINE = Math.sin(WEB_MERCATOR_MAX_LATITUDE * Math.PI / 180);
const LOCATION_STORAGE_KEY = "earth.location.v1";

type LocationStorage = Pick<Storage, "getItem" | "setItem">;

/** Restores and continuously persists the player's geographic location. */
export class WorldLocationStore {
  private current: WorldLocation;
  private readonly storage?: LocationStorage;

  constructor(fallback: WorldLocation, storage?: LocationStorage) {
    this.storage = storage;
    this.current = loadWorldLocation(fallback, storage);
  }

  get value(): Readonly<WorldLocation> {
    return this.current;
  }

  update(location: WorldLocation): void {
    if (!isValidWorldLocation(location)) return;
    this.current = { ...location };
    try {
      this.storage?.setItem(LOCATION_STORAGE_KEY, JSON.stringify(this.current));
    } catch {
      // Storage may be unavailable in private or embedded browsing contexts.
    }
  }
}

export function createBrowserWorldLocationStore(fallback: WorldLocation): WorldLocationStore {
  let storage: Storage | undefined;
  try {
    storage = window.localStorage;
  } catch {
    storage = undefined;
  }
  return new WorldLocationStore(fallback, storage);
}

function loadWorldLocation(
  fallback: WorldLocation,
  storage?: LocationStorage,
): WorldLocation {
  try {
    const stored = storage?.getItem(LOCATION_STORAGE_KEY);
    if (stored) {
      const candidate = JSON.parse(stored) as Partial<WorldLocation>;
      if (isValidWorldLocation(candidate)) return { lat: candidate.lat, lon: candidate.lon };
    }
  } catch {
    // Ignore malformed or inaccessible storage and retain the fallback.
  }
  return { ...fallback };
}

function isValidWorldLocation(location: Partial<WorldLocation>): location is WorldLocation {
  return typeof location.lat === "number" &&
    Number.isFinite(location.lat) &&
    Math.abs(location.lat) <= WEB_MERCATOR_MAX_LATITUDE &&
    typeof location.lon === "number" &&
    Number.isFinite(location.lon) &&
    location.lon >= -180 &&
    location.lon <= 180;
}

/** Picks a world location uniformly by surface area within Web Mercator's bounds. */
export function randomWorldLocation(random: () => number = Math.random): WorldLocation {
  const lon = random() * 360 - 180;
  const latitudeSine = (random() * 2 - 1) * WEB_MERCATOR_MAX_SINE;
  const lat = Math.asin(latitudeSine) * 180 / Math.PI;
  return { lat, lon };
}

/** Rejection-samples the globe until the supplied classifier confirms land. */
export async function randomLandWorldLocation(
  isLand: (location: WorldLocation) => boolean | Promise<boolean>,
  random: () => number = Math.random,
  maxAttempts = 100,
): Promise<WorldLocation> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const location = randomWorldLocation(random);
    if (await isLand(location)) return location;
  }
  throw new Error(`Could not find a land location after ${maxAttempts} attempts.`);
}
