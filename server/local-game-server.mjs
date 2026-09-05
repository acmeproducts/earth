import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { GameServer } from "./game-server.mjs";
import { SqliteGameStateRepository } from "./sqlite-game-state-repository.mjs";

const port = Number(process.env.GAME_PORT ?? 3001);
const databasePath = process.env.GAME_DATABASE ?? "./data/earth.sqlite";
const repository = new SqliteGameStateRepository(databasePath);
const game = new GameServer(repository);
const httpServer = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/plain" });
  response.end("Earth game backend is running.\n");
});
const sockets = new WebSocketServer({ server: httpServer, path: "/game" });

sockets.on("connection", (socket) => {
  let session;
  const send = (message) => socket.send(JSON.stringify(message));
  const listener = (event) => send({ type: "event", event });

  socket.on("message", async (raw) => {
    try {
      const message = JSON.parse(raw.toString());
      if (message.type === "join") {
        if (session) throw new Error("This connection has already joined a game.");
        const snapshot = await game.connect(message.request, listener);
        session = message.request;
        send({ type: "snapshot", snapshot });
      } else if (message.type === "action" && session) {
        await game.dispatch(session.sessionId, message.action);
      }
    } catch (error) {
      send({ type: "error", message: error instanceof Error ? error.message : "Game request failed." });
    }
  });
  socket.on("close", () => {
    if (session) game.disconnect(session.sessionId);
  });
});

httpServer.listen(port, () => console.log(`Earth game backend listening on ws://localhost:${port}/game`));
process.on("SIGINT", () => { repository.close(); httpServer.close(); });
process.on("SIGTERM", () => { repository.close(); httpServer.close(); });
