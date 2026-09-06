import type { GameConnection } from "./GameConnection";
import { LocalGameConnection } from "./LocalGameConnection";
import type {
  GameAction,
  GameEvent,
  GameEventListener,
  GameSnapshot,
  JoinGameRequest,
} from "./GameProtocol";

const ACTOR_ID_STORAGE_KEY = "earth.tab-actor-id.v1";

/** Browser transport for the real game backend. Game state never touches browser storage. */
export class WebSocketGameConnection implements GameConnection {
  private readonly url: string;
  private readonly listeners = new Set<GameEventListener>();
  private socket?: WebSocket;
  private dispatchQueue: Promise<void> = Promise.resolve();
  private resolveConnect?: (snapshot: GameSnapshot) => void;
  private rejectConnect?: (error: Error) => void;

  constructor(url: string) {
    this.url = url;
  }

  connect(request: JoinGameRequest): Promise<GameSnapshot> {
    if (this.socket) return Promise.reject(new Error("This game connection is already open."));
    this.socket = new WebSocket(this.url);
    this.socket.onopen = () => this.socket?.send(JSON.stringify({ type: "join", request }));
    this.socket.onmessage = (message) => this.handleMessage(message.data);
    this.socket.onerror = () => this.failConnect(new Error("Could not connect to the game backend."));
    this.socket.onclose = () => {
      this.failConnect(new Error("The game backend connection closed."));
      this.socket = undefined;
    };
    return new Promise<GameSnapshot>((resolve, reject) => {
      this.resolveConnect = resolve;
      this.rejectConnect = reject;
    });
  }

  dispatch(action: GameAction): Promise<void> {
    const dispatched = this.dispatchQueue.then(() => {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
        throw new Error("The game connection is not open.");
      }
      this.socket.send(JSON.stringify({ type: "action", action }));
    });
    this.dispatchQueue = dispatched.catch(() => undefined);
    return dispatched;
  }

  subscribe(listener: GameEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    await this.dispatchQueue;
    this.socket?.close();
    this.socket = undefined;
    this.listeners.clear();
  }

  private handleMessage(raw: unknown): void {
    let message: { type?: string; snapshot?: GameSnapshot; event?: GameEvent; message?: string };
    try {
      message = JSON.parse(String(raw));
    } catch {
      this.failConnect(new Error("The game backend sent invalid data."));
      return;
    }
    if (message.type === "snapshot" && message.snapshot) {
      this.resolveConnect?.(message.snapshot);
      this.resolveConnect = undefined;
      this.rejectConnect = undefined;
    } else if (message.type === "event" && message.event) {
      for (const listener of this.listeners) listener(message.event);
    } else if (message.type === "error") {
      this.failConnect(new Error(message.message ?? "Game backend request failed."));
    }
  }

  private failConnect(error: Error): void {
    this.rejectConnect?.(error);
    this.resolveConnect = undefined;
    this.rejectConnect = undefined;
  }
}

export interface BrowserGameConnection {
  connection: GameConnection;
  actorId: string;
  sessionId: string;
}

export function createBrowserGameConnection(): BrowserGameConnection {
  const query = new URLSearchParams(window.location.search);
  const configuredUrl = query.get("game-backend");
  const url = configuredUrl ?? `ws://${window.location.hostname || "localhost"}:3001/game`;
  let storage: Storage | undefined;
  try { storage = window.localStorage; } catch { /* Storage can be disabled. */ }
  const connection = requestedPersistence(query) === "server"
    ? new WebSocketGameConnection(url)
    : new LocalGameConnection(storage);
  return {
    connection,
    actorId: loadOrCreateTabActorId(),
    sessionId: createId(),
  };
}

/** Explicit local mode also overrides a previously configured backend URL. */
export function requestedPersistence(query: URLSearchParams): "local" | "server" {
  const mode = query.get("persistence");
  if (mode === "local" || mode === "server") return mode;
  return query.has("game-backend") ? "server" : "local";
}

function loadOrCreateTabActorId(): string {
  try {
    const existing = window.sessionStorage.getItem(ACTOR_ID_STORAGE_KEY);
    const navigation = performance.getEntriesByType("navigation")[0] as
      PerformanceNavigationTiming | undefined;
    // Chrome can clone sessionStorage when a tab is duplicated. A fresh
    // navigation must become a distinct player; reload/back-forward retains
    // the identity so the tab can restore its persisted pose.
    if (existing && navigation?.type !== "navigate") return existing;
    const created = createId();
    window.sessionStorage.setItem(ACTOR_ID_STORAGE_KEY, created);
    return created;
  } catch {
    return createId();
  }
}

function createId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}
