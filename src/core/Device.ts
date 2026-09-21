/** Coarse primary input identifies touch devices without penalizing touch laptops. */
export function isPhone(): boolean {
  if (typeof navigator === "undefined") return false;
  if (/iPhone|iPod|Android.*Mobile|Windows Phone/i.test(navigator.userAgent)) return true;
  return typeof window !== "undefined"
    && window.matchMedia?.("(pointer: coarse)").matches === true
    && Math.min(window.screen.width, window.screen.height) <= 600;
}
