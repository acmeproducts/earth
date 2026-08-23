export const GAME_TIME_SPEED = 24;

/** Real-world instant at which the accelerated game calendar began. */
export const GAME_TIME_EPOCH = new Date(2026, 0, 1, 0, 0, 0, 0).getTime();

/** Returns local game time, advancing 24 hours per real-world hour. */
export function getGameDate(now = Date.now()): Date {
  const gameElapsed = (now - GAME_TIME_EPOCH) * GAME_TIME_SPEED;
  const civilTime = new Date(Date.UTC(2026, 0, 1) + gameElapsed);
  return new Date(
    civilTime.getUTCFullYear(),
    civilTime.getUTCMonth(),
    civilTime.getUTCDate(),
    civilTime.getUTCHours(),
    civilTime.getUTCMinutes(),
    civilTime.getUTCSeconds(),
    civilTime.getUTCMilliseconds(),
  );
}
