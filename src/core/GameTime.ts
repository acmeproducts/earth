/** Returns the real local date and time used by the automatic clock. */
export function getGameDate(now = Date.now()): Date {
  return new Date(now);
}
