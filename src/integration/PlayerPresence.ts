import {
  Color3,
  Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
} from "@babylonjs/core";
import { lonLatToScene, sceneToLonLat } from "../Geo";
import type { SceneGeographicFrame } from "../Geo";
import type { GameConnection } from "./GameConnection";
import { createBrowserLocalGameConnection } from "./BrowserGameConnection";
import type {
  GameEvent,
  MovementMode,
  PlayerPose,
  PlayerState,
} from "./GameProtocol";

const POSE_PUBLISH_INTERVAL_MS = 100;
const REMOTE_PLAYER_ORB_DIAMETER_METERS = 1.2;

export interface GameIntegrationOptions {
  connection: GameConnection;
  worldId: string;
  actorId: string;
  sessionId: string;
}

export interface LocalPlayerTransform {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  movementMode: MovementMode;
}

export interface WorldLocationLike {
  lat: number;
  lon: number;
}

export interface PlayerPresenceSession {
  location: WorldLocationLike;
  restoredPose?: PlayerPose;
}

/** Owns player connection lifecycle, pose replication, and remote-player visualization. */
export class PlayerPresence {
  private readonly scene: Scene;
  private readonly connection: GameConnection;
  private readonly worldId: string;
  private readonly actorId: string;
  private readonly sessionId: string;
  private readonly remotePlayers = new Map<string, PlayerState>();
  private readonly markers = new Map<string, Mesh>();
  private material?: StandardMaterial;
  private unsubscribe?: () => void;
  private frame?: SceneGeographicFrame;
  private metersPerUnit?: number;
  private connected = false;
  private nextActionSequence = 0;
  private lastPublishMilliseconds = -Infinity;
  private lastPublishedPose?: PlayerPose;

  constructor(
    scene: Scene,
    integration?: GameIntegrationOptions,
  ) {
    this.scene = scene;
    const selected = integration ?? defaultBrowserIntegration();
    this.connection = selected.connection;
    this.worldId = selected.worldId;
    this.actorId = selected.actorId;
    this.sessionId = selected.sessionId;
  }

  async connect(fallbackLocation: WorldLocationLike): Promise<PlayerPresenceSession> {
    if (this.connected || this.unsubscribe) {
      throw new Error("Player presence is already connected.");
    }
    this.unsubscribe = this.connection.subscribe((event) => this.handleEvent(event));
    let snapshot;
    try {
      snapshot = await this.connection.connect({
        worldId: this.worldId,
        actorId: this.actorId,
        sessionId: this.sessionId,
      });
    } catch (error) {
      this.unsubscribe();
      this.unsubscribe = undefined;
      throw error;
    }
    this.connected = true;
    for (const player of snapshot.players) {
      if (player.actorId !== this.actorId) this.remotePlayers.set(player.actorId, player);
    }
    const restoredPose = snapshot.players.find(
      (player) => player.actorId === this.actorId,
    )?.pose;
    return {
      location: restoredPose
        ? { lat: restoredPose.latitude, lon: restoredPose.longitude }
        : { ...fallbackLocation },
      restoredPose: restoredPose ? { ...restoredPose } : undefined,
    };
  }

  setWorldFrame(frame: SceneGeographicFrame, metersPerUnit: number): void {
    this.frame = frame;
    this.metersPerUnit = metersPerUnit;
    this.syncMarkers();
  }

  clearWorldFrame(): void {
    this.frame = undefined;
    this.metersPerUnit = undefined;
    for (const marker of this.markers.values()) marker.setEnabled(false);
  }

  publishLocalTransform(transform: LocalPlayerTransform, force = false): void {
    const now = performance.now();
    if (!force && now - this.lastPublishMilliseconds < POSE_PUBLISH_INTERVAL_MS) return;
    const pose = this.toGeographicPose(transform);
    if (!this.connected || !pose) return;
    this.lastPublishMilliseconds = now;
    if (!force && this.lastPublishedPose && playerPosesEqual(this.lastPublishedPose, pose)) return;
    this.lastPublishedPose = { ...pose };
    void this.dispatchPose(pose).catch((error: unknown) => {
      console.warn("Could not publish the local player pose.", error);
    });
  }

  async publishDestination(
    location: WorldLocationLike,
    orientation: Pick<LocalPlayerTransform, "yaw" | "pitch" | "movementMode">,
  ): Promise<void> {
    if (!this.connected) return;
    await this.dispatchPose({
      longitude: location.lon,
      latitude: location.lat,
      // The client clamps this to the loaded terrain when the destination opens.
      elevationMeters: 0,
      ...orientation,
    });
  }

  dispose(): void {
    for (const marker of this.markers.values()) marker.dispose();
    this.markers.clear();
    this.material?.dispose();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.connected = false;
    void this.connection.close();
  }

  private toGeographicPose(transform: LocalPlayerTransform): PlayerPose | undefined {
    if (!this.frame || !this.metersPerUnit) return undefined;
    const position = sceneToLonLat(
      transform.x,
      transform.z,
      this.frame.bounds,
      this.frame.meshWidth,
      this.frame.meshDepth,
    );
    return {
      longitude: position.lon,
      latitude: position.lat,
      elevationMeters: transform.y * this.metersPerUnit,
      yaw: transform.yaw,
      pitch: transform.pitch,
      movementMode: transform.movementMode,
    };
  }

  private dispatchPose(pose: PlayerPose): Promise<void> {
    return this.connection.dispatch({
      type: "player.pose.update",
      clientSequence: this.nextActionSequence++,
      pose,
    });
  }

  private handleEvent(event: GameEvent): void {
    if (event.actorId === this.actorId) return;
    if (event.type === "player.left") {
      this.remotePlayers.delete(event.actorId);
      this.markers.get(event.actorId)?.dispose();
      this.markers.delete(event.actorId);
      return;
    }
    const current = this.remotePlayers.get(event.actorId);
    if (current && current.revision >= event.revision) return;
    this.remotePlayers.set(event.actorId, {
      worldId: event.worldId,
      actorId: event.actorId,
      pose: { ...event.pose },
      revision: event.revision,
      updatedAt: event.occurredAt,
    });
    this.updateMarker(event.actorId);
  }

  private syncMarkers(): void {
    for (const actorId of this.remotePlayers.keys()) this.updateMarker(actorId);
  }

  private updateMarker(actorId: string): void {
    const player = this.remotePlayers.get(actorId);
    if (!player || !this.frame || !this.metersPerUnit) return;
    let marker = this.markers.get(actorId);
    if (!marker) {
      this.material ??= createRemotePlayerMaterial(this.scene);
      marker = MeshBuilder.CreateSphere(`remote-player-${actorId}`, {
        diameter: 1,
        segments: 12,
      }, this.scene);
      marker.material = this.material;
      marker.isPickable = false;
      this.markers.set(actorId, marker);
    }
    marker.scaling.setAll(REMOTE_PLAYER_ORB_DIAMETER_METERS / this.metersPerUnit);
    const position = lonLatToScene(
      player.pose.longitude,
      player.pose.latitude,
      this.frame.bounds,
      this.frame.meshWidth,
      this.frame.meshDepth,
    );
    marker.position.set(
      position.x,
      player.pose.elevationMeters / this.metersPerUnit,
      position.z,
    );
    marker.setEnabled(true);
  }
}

function defaultBrowserIntegration(): GameIntegrationOptions {
  const local = createBrowserLocalGameConnection();
  return {
    connection: local.connection,
    worldId: "earth",
    actorId: local.actorId,
    sessionId: local.sessionId,
  };
}

function createRemotePlayerMaterial(scene: Scene): StandardMaterial {
  const material = new StandardMaterial("remote-player-red", scene);
  material.diffuseColor = new Color3(1, 0, 0);
  material.emissiveColor = new Color3(0.35, 0, 0);
  material.specularColor = Color3.Black();
  return material;
}

function playerPosesEqual(a: PlayerPose, b: PlayerPose): boolean {
  return Math.abs(a.latitude - b.latitude) < 1e-10
    && Math.abs(a.longitude - b.longitude) < 1e-10
    && Math.abs(a.elevationMeters - b.elevationMeters) < 1e-3
    && Math.abs(a.yaw - b.yaw) < 1e-5
    && Math.abs(a.pitch - b.pitch) < 1e-5
    && a.movementMode === b.movementMode;
}
