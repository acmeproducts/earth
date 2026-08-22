export const FLY_CAMERA_INERTIA = 0.9;
export const WALK_CAMERA_INERTIA = 0;

const GRAVITY_METERS_PER_SECOND_SQUARED = 9.81;
const GROUND_CONTACT_TOLERANCE_METERS = 0.05;
const MAX_STEP_DOWN_METERS = 0.75;

export interface WalkerVerticalMotionInput {
  eyeHeight: number;
  verticalVelocityMetersPerSecond: number;
  groundEyeHeightBeforeMove?: number;
  groundEyeHeightAfterMove?: number;
  metersPerUnit: number;
  deltaSeconds: number;
}

export interface WalkerVerticalMotion {
  eyeHeight: number;
  verticalVelocityMetersPerSecond: number;
}

/** Keeps a grounded walker planted on slopes while retaining gravity for real drops. */
export function advanceWalkerVerticalMotion(
  input: WalkerVerticalMotionInput,
): WalkerVerticalMotion {
  const {
    eyeHeight,
    groundEyeHeightBeforeMove,
    groundEyeHeightAfterMove,
    metersPerUnit,
    deltaSeconds,
  } = input;

  const wasGrounded = groundEyeHeightBeforeMove !== undefined
    && Math.abs(eyeHeight - groundEyeHeightBeforeMove) * metersPerUnit
      <= GROUND_CONTACT_TOLERANCE_METERS
    && input.verticalVelocityMetersPerSecond <= 0;
  const stepDownMeters = groundEyeHeightBeforeMove !== undefined
    && groundEyeHeightAfterMove !== undefined
    ? (groundEyeHeightBeforeMove - groundEyeHeightAfterMove) * metersPerUnit
    : Infinity;

  if (wasGrounded && groundEyeHeightAfterMove !== undefined
      && stepDownMeters <= MAX_STEP_DOWN_METERS) {
    return {
      eyeHeight: groundEyeHeightAfterMove,
      verticalVelocityMetersPerSecond: 0,
    };
  }

  let verticalVelocityMetersPerSecond = input.verticalVelocityMetersPerSecond
    - GRAVITY_METERS_PER_SECOND_SQUARED * deltaSeconds;
  let nextEyeHeight = eyeHeight
    + verticalVelocityMetersPerSecond * deltaSeconds / metersPerUnit;
  if (groundEyeHeightAfterMove !== undefined && nextEyeHeight <= groundEyeHeightAfterMove) {
    nextEyeHeight = groundEyeHeightAfterMove;
    verticalVelocityMetersPerSecond = 0;
  }

  return {
    eyeHeight: nextEyeHeight,
    verticalVelocityMetersPerSecond,
  };
}
