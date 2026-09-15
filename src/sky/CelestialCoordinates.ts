export type SceneCelestialRotation = readonly [
  eastFromX: number,
  eastFromY: number,
  eastFromZ: number,
  upFromX: number,
  upFromY: number,
  upFromZ: number,
  northFromX: number,
  northFromY: number,
  northFromZ: number,
];

export interface SceneDirection {
  x: number;
  y: number;
  z: number;
}

/** Maps Astronomy Engine's north/west/up rotation into east/up/north. */
export function horizontalToSceneRotation(
  horizontal: readonly (readonly number[])[],
): SceneCelestialRotation {
  return [
    -horizontal[0][1], -horizontal[1][1], -horizontal[2][1],
    horizontal[0][2], horizontal[1][2], horizontal[2][2],
    horizontal[0][0], horizontal[1][0], horizontal[2][0],
  ];
}

export function rotateJ2000Direction(
  rotation: SceneCelestialRotation,
  x: number,
  y: number,
  z: number,
): SceneDirection {
  return {
    x: rotation[0] * x + rotation[1] * y + rotation[2] * z,
    y: rotation[3] * x + rotation[4] * y + rotation[5] * z,
    z: rotation[6] * x + rotation[7] * y + rotation[8] * z,
  };
}
