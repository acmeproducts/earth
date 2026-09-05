import type {
  GameAction,
  GameEventListener,
  GameSnapshot,
  JoinGameRequest,
} from "./GameProtocol";

export interface GameConnection {
  connect(request: JoinGameRequest): Promise<GameSnapshot>;
  dispatch(action: GameAction): Promise<void>;
  subscribe(listener: GameEventListener): () => void;
  close(): Promise<void>;
}
