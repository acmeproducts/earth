/** Buried/covered water must not be draped onto the visible terrain surface. */
export function isSurfaceWaterFeature(properties: Readonly<Record<string, unknown>>): boolean {
  const text = (value: unknown) => String(value ?? "").trim().toLowerCase();
  const enabled = (value: unknown) => !["", "0", "no", "false"].includes(text(value));
  return !enabled(properties.intermittent) &&
    text(properties.brunnel) !== "tunnel" &&
    !enabled(properties.tunnel) &&
    !enabled(properties.covered) &&
    text(properties.location) !== "underground" &&
    !(Number(properties.layer) < 0);
}
