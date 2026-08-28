import type {
  GameAction,
  GameEventListener,
  GameSnapshot,
  JoinGameRequest,
} from "./GameProtocol";
import { GameServer } from "./GameServer";

export interface GameConnection {
  connect(request: JoinGameRequest): Promise<GameSnapshot>;
  dispatch(action: GameAction): Promise<void>;
  subscribe(listener: GameEventListener): () => void;
  close(): Promise<void>;
}

/** In-process transport. A WebSocket adapter can implement the same interface later. */
export class LocalGameConnection implements GameConnection {
  private readonly listeners = new Set<GameEventListener>();
  private readonly server: GameServer;
  private sessionId?: string;
  private dispatchQueue: Promise<void> = Promise.resolve();

  constructor(server: GameServer) {
    this.server = server;
  }

  async connect(request: JoinGameRequest): Promise<GameSnapshot> {
    if (this.sessionId) throw new Error("This game connection is already open.");
    const snapshot = await this.server.connect(request, (event) => {
      for (const listener of this.listeners) listener(event);
    });
    this.sessionId = request.sessionId;
    return snapshot;
  }

  dispatch(action: GameAction): Promise<void> {
    if (!this.sessionId) return Promise.reject(new Error("The game connection is not open."));
    const sessionId = this.sessionId;
    const dispatched = this.dispatchQueue.then(() => this.server.dispatch(sessionId, action));
    this.dispatchQueue = dispatched.catch(() => undefined);
    return dispatched;
  }

  subscribe(listener: GameEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    await this.dispatchQueue;
    if (this.sessionId) this.server.disconnect(this.sessionId);
    this.sessionId = undefined;
    this.listeners.clear();
  }
}
