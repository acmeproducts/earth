import type { Engine } from '@babylonjs/core';

interface ClipControl {
  readonly LOWER_LEFT_EXT: number;
  readonly ZERO_TO_ONE_EXT: number;
  clipControlEXT(origin: number, depth: number): void;
}

/** Avoids losing reverse-depth precision in WebGL's default NDC remapping. */
export function enableWebGLHalfRangeDepth(engine: Engine): boolean {
  const apply = (): boolean => {
    const extension = engine._gl.getExtension('EXT_clip_control') as ClipControl | null;
    if (!extension) return false;
    extension.clipControlEXT(extension.LOWER_LEFT_EXT, extension.ZERO_TO_ONE_EXT);
    // Babylon 7 exposes the backend flag as readonly, but its projection and
    // shader paths already support this range for WebGPU.
    (engine as unknown as { isNDCHalfZRange: boolean }).isNDCHalfZRange = true;
    return true;
  };
  if (!apply()) return false;
  engine.onContextRestoredObservable.add(apply);
  return true;
}
