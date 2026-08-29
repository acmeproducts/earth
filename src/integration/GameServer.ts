import {
  clonePlayerPose,
  clonePlayerState,
  isValidPlayerPose,
} from "./GameProtocol";
import type {
  GameAction,
  GameEvent,
  GameEventListener,
  GameSnapshot,
  JoinGameRequest,
  PlayerPose,
  PlayerState,
} from "./GameProtocol";
import type { GameStateRepository } from "./GameStateRepository";

interface ConnectedSession extends JoinGameRequest {
  listener: GameEventListener;
  lastClientSequence: number;
}

/** Authoritative game logic shared by local and future remote transports. */
export class GameServer {
  private readonly sessions = new Map<string, ConnectedSession>();
  private readonly repository: GameStateRepository;
  private readonly now: () => number;

  constructor(
    repository: GameStateRepository,
    now: () => number = Date.now,
  ) {
    this.repository = repository;
    this.now = now;
  }

  async connect(request: JoinGameRequest, listener: GameEventListener): Promise<GameSnapshot> {
    if (!request.worldId || !request.actorId || !request.sessionId) {
      throw new Error("A world, actor, and session are required to connect.");
    }
    if (this.sessions.has(request.sessionId)) {
      throw new Error(`Session ${request.sessionId} is already connected.`);
    }
    this.sessions.set(request.sessionId, { ...request, listener, lastClientSequence: -1 });
    const players = await this.repository.loadPlayers(request.worldId);
    const connectedActors = new Set(
      [...this.sessions.values()]
        .filter((session) => session.worldId === request.worldId)
        .map((session) => session.actorId),
    );
    return {
      worldId: request.worldId,
      players: players.filter((player) => connectedActors.has(player.actorId)).map(clonePlayerState),
    };
  }

  async dispatch(sessionId: string, action: GameAction): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("The game session is not connected.");
    if (!Number.isSafeInteger(action.clientSequence) || action.clientSequence < 0) {
      throw new Error("Game actions require a non-negative integer sequence.");
    }
    if (action.clientSequence <= session.lastClientSequence) return;
    session.lastClientSequence = action.clientSequence;

    switch (action.type) {
      case "player.pose.update":
        await this.updatePlayerPose(session, action.pose);
        return;
    }
  }

  disconnect(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    const actorStillConnected = [...this.sessions.values()].some(
      (candidate) => candidate.worldId === session.worldId
        && candidate.actorId === session.actorId,
    );
    if (actorStillConnected) return;
    this.fanOut(session.worldId, {
      type: "player.left",
      worldId: session.worldId,
      actorId: session.actorId,
      originSessionId: session.sessionId,
      occurredAt: this.now(),
    });
  }

  private async updatePlayerPose(session: ConnectedSession, pose: PlayerPose): Promise<void> {
    if (!isValidPlayerPose(pose)) throw new Error("The player pose is invalid.");
    const players = await this.repository.loadPlayers(session.worldId);
    const previous = players.find((player) => player.actorId === session.actorId);
    const occurredAt = this.now();
    const state: PlayerState = {
      worldId: session.worldId,
      actorId: session.actorId,
      pose: clonePlayerPose(pose),
      temperature: previous?.temperature ?? 37,
      hunger: previous?.hunger ?? 100,
      thirst: previous?.thirst ?? 100,
      revision: (previous?.revision ?? 0) + 1,
      updatedAt: occurredAt,
    };
    await this.repository.savePlayer(state);

    const event: GameEvent = {
      type: "player.pose.changed",
      worldId: session.worldId,
      actorId: session.actorId,
      originSessionId: session.sessionId,
      revision: state.revision,
      occurredAt,
      pose: clonePlayerPose(pose),
    };
    this.fanOut(session.worldId, event);
  }

  private fanOut(worldId: string, event: GameEvent): void {
    for (const target of this.sessions.values()) {
      if (target.worldId !== worldId) continue;
      try {
        target.listener(cloneEvent(event));
      } catch (error) {
        console.error(`Game event listener failed for session ${target.sessionId}.`, error);
      }
    }
  }
}

function cloneEvent(event: GameEvent): GameEvent {
  return event.type === "player.pose.changed"
    ? { ...event, pose: clonePlayerPose(event.pose) }
    : { ...event };
}
