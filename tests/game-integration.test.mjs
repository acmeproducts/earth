import assert from "node:assert/strict";
import test from "node:test";

import { GameServer } from "../server/game-server.mjs";

const pose = {
  longitude: 10.75,
  latitude: 59.91,
  elevationMeters: 142.5,
  yaw: 1.2,
  pitch: -0.15,
  movementMode: "walk",
};

test("persists poses and fans cloned events out within one world", async () => {
  const repository = new MemoryRepository();
  const server = new GameServer(repository, () => 1234);
  const firstEvents = [];
  const secondEvents = [];
  await server.connect(join("alice", "session-a"), (event) => {
    firstEvents.push(event);
    event.pose.yaw = 99;
  });
  await server.connect(join("bob", "session-b"), (event) => secondEvents.push(event));
  await server.dispatch("session-a", update(0, pose));

  assert.equal(firstEvents[0].pose.yaw, 99);
  assert.deepEqual(secondEvents, [poseEvent("alice", "session-a", 1, 1234, pose)]);
  assert.deepEqual(await repository.loadPlayers("earth"), [{
    worldId: "earth",
    actorId: "alice",
    temperature: 37,
    hunger: 100,
    thirst: 100,
    revision: 1,
    updatedAt: 1234,
    pose,
  }]);
});

test("snapshots include persisted online players but stay within one world", async () => {
  const repository = new MemoryRepository();
  const server = new GameServer(repository);
  await server.connect(join("alice", "earth-a"), () => undefined);
  await server.dispatch("earth-a", update(0, pose));
  await server.connect(join("alice", "mars-a", "mars"), () => undefined);

  const snapshot = await server.connect(join("bob", "earth-b"), () => undefined);
  assert.equal(snapshot.players.length, 1);
  assert.equal(snapshot.players[0].actorId, "alice");
  assert.equal(snapshot.players[0].revision, 1);
});

test("serializes actions and ignores duplicate or out-of-order sequences", async () => {
  const repository = new MemoryRepository();
  const server = new GameServer(repository);
  await server.connect(join("alice", "session-a"), () => undefined);

  await Promise.all([
    server.dispatch("session-a", update(4, pose)),
    server.dispatch("session-a", update(5, { ...pose, yaw: 2 })),
  ]);
  await server.dispatch("session-a", update(3, { ...pose, yaw: 3 }));

  const [stored] = await repository.loadPlayers("earth");
  assert.equal(stored.pose.yaw, 2);
  assert.equal(stored.revision, 2);
});

test("rejects invalid poses without consuming their sequence", async () => {
  const repository = new MemoryRepository();
  const server = new GameServer(repository);
  await server.connect(join("alice", "session-a"), () => undefined);

  await assert.rejects(
    server.dispatch("session-a", update(0, { ...pose, latitude: 90 })),
    /Invalid player pose/,
  );
  await server.dispatch("session-a", update(0, pose));
  assert.equal((await repository.loadPlayers("earth"))[0].revision, 1);
});

test("a failed connection does not reserve its session id", async () => {
  const repository = new MemoryRepository();
  const server = new GameServer(repository);
  repository.failNextLoad = true;

  await assert.rejects(server.connect(join("alice", "session-a"), () => undefined));
  await server.connect(join("alice", "session-a"), () => undefined);
});

test("only the final session for an actor emits its departure", async () => {
  const server = new GameServer(new MemoryRepository(), () => 5678);
  const events = [];
  await server.connect(join("alice", "alice-a"), () => undefined);
  await server.connect(join("alice", "alice-b"), () => undefined);
  await server.connect(join("bob", "bob-a"), (event) => events.push(event));

  server.disconnect("alice-a");
  assert.deepEqual(events, []);
  server.disconnect("alice-b");
  assert.deepEqual(events, [{
    type: "player.left",
    worldId: "earth",
    actorId: "alice",
    originSessionId: "alice-b",
    occurredAt: 5678,
  }]);
});

function join(actorId, sessionId, worldId = "earth") {
  return { worldId, actorId, sessionId };
}

function update(clientSequence, nextPose) {
  return { type: "player.pose.update", clientSequence, pose: nextPose };
}

function poseEvent(actorId, originSessionId, revision, occurredAt, nextPose) {
  return {
    type: "player.pose.changed",
    worldId: "earth",
    actorId,
    originSessionId,
    revision,
    occurredAt,
    pose: nextPose,
  };
}

class MemoryRepository {
  players = new Map();
  failNextLoad = false;

  async loadPlayers(worldId) {
    if (this.failNextLoad) {
      this.failNextLoad = false;
      throw new Error("load failed");
    }
    return [...this.players.values()]
      .filter((player) => player.worldId === worldId)
      .map((player) => structuredClone(player));
  }

  async savePlayer(state) {
    this.players.set(`${state.worldId}\0${state.actorId}`, structuredClone(state));
  }
}
