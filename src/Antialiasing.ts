export type AntialiasingMode = "msaa" | "fxaa" | "taa" | "off";

export const ANTIALIASING_OPTIONS: readonly { value: AntialiasingMode; label: string; description: string }[] = [
  { value: "msaa", label: "MSAA 4×", description: "Smooth geometry edges without temporal trails." },
  { value: "fxaa", label: "FXAA", description: "Fast edge smoothing; may soften fine detail." },
  { value: "taa", label: "TAA (experimental)", description: "Accumulates still views. Moving water and foliage can leave trails." },
  { value: "off", label: "Off", description: "No scene antialiasing." },
];

export function isAntialiasingMode(value: unknown): value is AntialiasingMode {
  return ANTIALIASING_OPTIONS.some((option) => option.value === value);
}

const STORAGE_KEY = "earth.antialiasing.v1";

export function loadAntialiasing(query: URLSearchParams): AntialiasingMode {
  const requested = query.get("aa")?.toLowerCase();
  if (isAntialiasingMode(requested)) return requested;
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (isAntialiasingMode(saved)) return saved;
  } catch { /* Storage can be unavailable. */ }
  return "msaa";
}

export function saveAntialiasing(mode: AntialiasingMode): void {
  try { window.localStorage.setItem(STORAGE_KEY, mode); } catch { /* Keep the live choice. */ }
  const url = new URL(window.location.href);
  if (url.searchParams.has("aa")) {
    url.searchParams.set("aa", mode);
    window.history.replaceState(window.history.state, "", url);
  }
}
