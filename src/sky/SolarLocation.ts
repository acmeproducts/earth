/** Roughly 5 km; smaller moves have no meaningful effect on celestial lighting. */
const MIN_LOCATION_UPDATE_DEGREES = 0.05;

/** True once geographic movement is large enough to change celestial lighting. */
export function shouldUpdateSolarLocation(
  previousLatitude: number,
  previousLongitude: number,
  latitude: number,
  longitude: number,
): boolean {
  if (![previousLatitude, previousLongitude, latitude, longitude].every(Number.isFinite)) {
    return true;
  }
  const latitudeDelta = latitude - previousLatitude;
  const rawLongitudeDelta = Math.abs(longitude - previousLongitude) % 360;
  const longitudeDelta = Math.min(rawLongitudeDelta, 360 - rawLongitudeDelta) *
    Math.cos(((latitude + previousLatitude) * Math.PI) / 360);
  return Math.hypot(latitudeDelta, longitudeDelta) >= MIN_LOCATION_UPDATE_DEGREES;
}
