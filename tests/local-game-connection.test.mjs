import assert from "node:assert/strict";
import test from "node:test";
import { LocalGameConnection } from "../src/integration/LocalGameConnection.ts";
import { requestedPersistence } from "../src/integration/BrowserGameConnection.ts";

const request = { worldId: "earth", actorId: "first", sessionId: "session" };
const pose = { latitude: 59, longitude: 11, elevationMeters: 140, yaw: 1, pitch: 0.2, movementMode: "fly" };

test("local is the default and an explicit mode overrides the backend URL", () => {
  for (const [query, expected] of [
    ["", "local"], ["persistence=server", "server"],
    ["game-backend=ws://localhost:3001/game", "server"],
    ["persistence=local&game-backend=ws://localhost:3001/game", "local"],
  ]) assert.equal(requestedPersistence(new URLSearchParams(query)), expected);
});

test("restores the complete local pose across sessions and isolates worlds", async () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  const first = new LocalGameConnection(storage);
  assert.deepEqual((await first.connect(request)).players, []);
  await first.dispatch({ type: "player.pose.update", clientSequence: 0, pose });
  await first.close();
  const next = new LocalGameConnection(storage);
  const snapshot = await next.connect({ ...request, actorId: "new-visit" });
  assert.deepEqual(snapshot.players[0].pose, pose);
  assert.equal(snapshot.players[0].actorId, "new-visit");
  const other = new LocalGameConnection(storage);
  assert.deepEqual((await other.connect({ ...request, worldId: "other" })).players, []);
});

test("unusable browser saves do not block local play", async () => {
  for (const value of ["bad json", "null", "{}", JSON.stringify({ ...pose, latitude: 90 })]) {
    const connection = new LocalGameConnection({
      getItem: () => value, setItem: () => { throw new Error("Storage full"); },
    });
    assert.deepEqual((await connection.connect(request)).players, []);
    await connection.dispatch({ type: "player.pose.update", clientSequence: 0, pose });
  }
});
