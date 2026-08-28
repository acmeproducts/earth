export type MovementMode = "fly" | "walk";

/** A transport-safe player pose expressed in the shared geographic world frame. */
export interface PlayerPose {
  longitude: number;
  latitude: number;
  elevationMeters: number;
  yaw: number;
  pitch: number;
  movementMode: MovementMode;
}

export interface JoinGameRequest {
  worldId: string;
  actorId: string;
  sessionId: string;
}

export interface PlayerState {
  worldId: string;
  actorId: string;
  pose: PlayerPose;
  revision: number;
  updatedAt: number;
}

export interface GameSnapshot {
  worldId: string;
  players: PlayerState[];
}

export interface UpdatePlayerPoseAction {
  type: "player.pose.update";
  clientSequence: number;
  pose: PlayerPose;
}

/** Extend this union as environment interactions are introduced. */
export type GameAction = UpdatePlayerPoseAction;

export interface PlayerPoseChangedEvent {
  type: "player.pose.changed";
  worldId: string;
  actorId: string;
  originSessionId: string;
  revision: number;
  occurredAt: number;
  pose: PlayerPose;
}

export interface PlayerLeftEvent {
  type: "player.left";
  worldId: string;
  actorId: string;
  originSessionId: string;
  occurredAt: number;
}

/** Events are authoritative outcomes emitted by the game server. */
export type GameEvent = PlayerPoseChangedEvent | PlayerLeftEvent;

export type GameEventListener = (event: GameEvent) => void;

export function isValidPlayerPose(pose: PlayerPose): boolean {
  return Number.isFinite(pose.longitude)
    && pose.longitude >= -180
    && pose.longitude <= 180
    && Number.isFinite(pose.latitude)
    && Math.abs(pose.latitude) <= 85.05112878
    && Number.isFinite(pose.elevationMeters)
    && Number.isFinite(pose.yaw)
    && Number.isFinite(pose.pitch)
    && (pose.movementMode === "fly" || pose.movementMode === "walk");
}

export function clonePlayerPose(pose: PlayerPose): PlayerPose {
  return { ...pose };
}

export function clonePlayerState(state: PlayerState): PlayerState {
  return { ...state, pose: clonePlayerPose(state.pose) };
}
