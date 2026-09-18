export function number(value: number): string {
  return String(Math.round(value * 100) / 100);
}

export function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&apos;",
  })[character] ?? character);
}

export function positiveDimension(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function diagonalGradient(id: string, start: string, end: string): string {
  return `<linearGradient id="${escapeXml(id)}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${escapeXml(start)}"/><stop offset="1" stop-color="${escapeXml(end)}"/></linearGradient>`;
}
