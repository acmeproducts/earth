import { WEB_MERCATOR_MAX_LATITUDE } from "./Locations";
import type { WorldLocation } from "./Locations";

export interface GeocodedLocation extends WorldLocation {
  displayName: string;
}

interface NominatimResult {
  lat?: unknown;
  lon?: unknown;
  display_name?: unknown;
}

const DEFAULT_SEARCH_ENDPOINT = "https://nominatim.openstreetmap.org/search";
const REQUEST_INTERVAL_MS = 1_000;
const CACHE_PREFIX = "earth.geocoding.v1:";
const memoryCache = new Map<string, GeocodedLocation | null>();
let nextRequestAt = 0;
let requestQueue: Promise<void> = Promise.resolve();

export async function geocodeLocationName(query: string): Promise<GeocodedLocation | null> {
  const normalizedQuery = query.trim().replace(/\s+/g, " ");
  if (!normalizedQuery) return null;

  const endpoint = geocodingEndpoint();
  const cacheKey = `${endpoint}:${normalizedQuery.toLocaleLowerCase()}`;
  const cached = readCachedLocation(cacheKey);
  if (cached !== undefined) return cached;

  const parameters = new URLSearchParams({
    q: normalizedQuery,
    format: "jsonv2",
    limit: "1",
  });
  const results = await rateLimitedRequest(`${endpoint}?${parameters.toString()}`);
  const location = parseResult(results[0]);
  writeCachedLocation(cacheKey, location);
  return location;
}

function geocodingEndpoint(): string {
  const configured = document.querySelector<HTMLMetaElement>('meta[name="geocoder-url"]')?.content.trim();
  return configured || DEFAULT_SEARCH_ENDPOINT;
}

async function rateLimitedRequest(url: string): Promise<NominatimResult[]> {
  let releaseQueue!: () => void;
  const previousRequest = requestQueue;
  requestQueue = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  await previousRequest;

  try {
    const delay = Math.max(0, nextRequestAt - Date.now());
    if (delay > 0) await wait(delay);
    nextRequestAt = Date.now() + REQUEST_INTERVAL_MS;

    const response = await fetch(url, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`Geocoding request failed with status ${response.status}.`);
    const body: unknown = await response.json();
    if (!Array.isArray(body)) throw new Error("Geocoding response was not a result list.");
    return body as NominatimResult[];
  } finally {
    releaseQueue();
  }
}

function parseResult(result: NominatimResult | undefined): GeocodedLocation | null {
  if (!result) return null;
  const lat = Number(result.lat);
  const lon = Number(result.lon);
  if (
    !Number.isFinite(lat)
    || !Number.isFinite(lon)
    || lat < -WEB_MERCATOR_MAX_LATITUDE
    || lat > WEB_MERCATOR_MAX_LATITUDE
    || lon < -180
    || lon > 180
    || typeof result.display_name !== "string"
  ) {
    return null;
  }
  return { lat, lon, displayName: result.display_name };
}

function readCachedLocation(cacheKey: string): GeocodedLocation | null | undefined {
  if (memoryCache.has(cacheKey)) return memoryCache.get(cacheKey);
  try {
    const stored = sessionStorage.getItem(CACHE_PREFIX + cacheKey);
    if (stored === null) return undefined;
    const parsed: unknown = JSON.parse(stored);
    const location = parsed === null ? null : parseCachedLocation(parsed);
    if (parsed !== null && !location) return undefined;
    memoryCache.set(cacheKey, location);
    return location;
  } catch {
    return undefined;
  }
}

function parseCachedLocation(value: unknown): GeocodedLocation | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<GeocodedLocation>;
  if (
    typeof candidate.lat !== "number"
    || typeof candidate.lon !== "number"
    || typeof candidate.displayName !== "string"
  ) {
    return null;
  }
  return parseResult({
    lat: candidate.lat,
    lon: candidate.lon,
    display_name: candidate.displayName,
  });
}

function writeCachedLocation(cacheKey: string, location: GeocodedLocation | null): void {
  memoryCache.set(cacheKey, location);
  try {
    sessionStorage.setItem(CACHE_PREFIX + cacheKey, JSON.stringify(location));
  } catch {
    // In-memory caching still prevents duplicate requests when storage is unavailable.
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}
