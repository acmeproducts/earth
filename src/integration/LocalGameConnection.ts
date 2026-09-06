import type { GameConnection } from "./GameConnection";
import { isValidPlayerPose } from "./GameProtocol";
import type { GameAction, GameEventListener, GameSnapshot, JoinGameRequest, PlayerPose } from "./GameProtocol";

type LocalStorage = Pick<Storage, "getItem" | "setItem">;

/** Single-player connection that saves a pose per world across browser sessions. */
export class LocalGameConnection implements GameConnection {
  private request?: JoinGameRequest;
  private readonly listeners = new Set<GameEventListener>();
  private revision = 0;
  private readonly storage?: LocalStorage;

  constructor(storage?: LocalStorage) {
    this.storage = storage;
  }

  async connect(request: JoinGameRequest): Promise<GameSnapshot> {
    if (this.request) throw new Error("This game connection is already open.");
    this.request = { ...request };
    let pose: PlayerPose | undefined;
    try {
      const candidate = JSON.parse(this.storage?.getItem(this.storageKey) ?? "null");
      if (candidate && isValidPlayerPose(candidate)) pose = candidate;
    } catch {
      // Missing, malformed, or inaccessible storage starts at the fallback location.
    }
    return {
      worldId: request.worldId,
      players: pose ? [{
        worldId: request.worldId, actorId: request.actorId, pose: { ...pose },
        temperature: 37, hunger: 100, thirst: 100, revision: 0, updatedAt: Date.now(),
      }] : [],
    };
  }

  async dispatch(action: GameAction): Promise<void> {
    if (!this.request) throw new Error("The game connection is not open.");
    if (action.type !== "player.pose.update" || !action.pose || !isValidPlayerPose(action.pose)) {
      throw new Error("Invalid player pose.");
    }
    try {
      this.storage?.setItem(this.storageKey, JSON.stringify(action.pose));
    } catch {
      // Keep the game playable when browser storage is unavailable or full.
    }
    const revision = ++this.revision;
    for (const listener of this.listeners) listener({
      type: "player.pose.changed", worldId: this.request.worldId,
      actorId: this.request.actorId, originSessionId: this.request.sessionId,
      revision, occurredAt: Date.now(), pose: { ...action.pose },
    });
  }

  subscribe(listener: GameEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    this.request = undefined;
    this.listeners.clear();
  }

  private get storageKey(): string {
    return `earth.player-pose.v1:${this.request!.worldId}`;
  }
}
