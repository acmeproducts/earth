import {
  clonePlayerState,
  isValidPlayerPose,
  isValidPlayerVitals,
} from "./GameProtocol";
import type { PlayerState } from "./GameProtocol";

export interface GameStateRepository {
  loadPlayers(worldId: string): Promise<PlayerState[]>;
  savePlayer(state: PlayerState): Promise<void>;
}

/** Useful for tests and non-persistent local sessions. */
export class InMemoryGameStateRepository implements GameStateRepository {
  private readonly players = new Map<string, PlayerState>();

  async loadPlayers(worldId: string): Promise<PlayerState[]> {
    return [...this.players.values()]
      .filter((player) => player.worldId === worldId)
      .map(clonePlayerState);
  }

  async savePlayer(state: PlayerState): Promise<void> {
    this.players.set(playerKey(state.worldId, state.actorId), clonePlayerState(state));
  }
}

type KeyValueStorage = Pick<Storage, "getItem" | "setItem">;

interface PersistedGameState {
  version: 1;
  players: Record<string, unknown>;
}

const GAME_STATE_STORAGE_KEY = "earth.game-state.v1";

/** Browser-local persistence adapter. Its asynchronous API also fits future Postgres storage. */
export class BrowserGameStateRepository implements GameStateRepository {
  private readonly storage?: KeyValueStorage;

  constructor(storage?: KeyValueStorage) {
    this.storage = storage;
  }

  async loadPlayers(worldId: string): Promise<PlayerState[]> {
    const stored = this.read();
    return Object.values(stored.players)
      .filter(isValidPlayerState)
      .filter((player) => player.worldId === worldId)
      .map(clonePlayerState);
  }

  async savePlayer(state: PlayerState): Promise<void> {
    if (!isValidPlayerState(state)) return;
    const stored = this.read();
    stored.players[playerKey(state.worldId, state.actorId)] = clonePlayerState(state);
    try {
      this.storage?.setItem(GAME_STATE_STORAGE_KEY, JSON.stringify(stored));
    } catch {
      // Storage can be unavailable or full in private and embedded contexts.
    }
  }

  private read(): PersistedGameState {
    try {
      const value = this.storage?.getItem(GAME_STATE_STORAGE_KEY);
      if (!value) return emptyState();
      const candidate = JSON.parse(value) as Partial<PersistedGameState>;
      if (candidate.version !== 1 || !candidate.players || typeof candidate.players !== "object") {
        return emptyState();
      }
      return { version: 1, players: { ...candidate.players } };
    } catch {
      return emptyState();
    }
  }
}

function emptyState(): PersistedGameState {
  return { version: 1, players: {} };
}

function playerKey(worldId: string, actorId: string): string {
  return `${worldId}\u0000${actorId}`;
}

function isValidPlayerState(state: unknown): state is PlayerState {
  if (!state || typeof state !== "object") return false;
  const candidate = state as Partial<PlayerState>;
  return typeof candidate.worldId === "string"
    && candidate.worldId.length > 0
    && typeof candidate.actorId === "string"
    && candidate.actorId.length > 0
    && Number.isSafeInteger(candidate.revision)
    && (candidate.revision ?? -1) >= 0
    && Number.isFinite(candidate.updatedAt)
    && candidate.pose !== undefined
    && isValidPlayerPose(candidate.pose)
    && isValidPlayerVitals(
      candidate.temperature ?? 37,
      candidate.hunger ?? 100,
      candidate.thirst ?? 100,
    );
}
