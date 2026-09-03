import assert from "node:assert/strict";
import test from "node:test";

const { LocalGameConnection } = await import("../src/integration/GameConnection.ts");
const { BrowserBroadcastGameConnection } = await import(
  "../src/integration/BrowserGameConnection.ts"
);
const { GameServer } = await import("../src/integration/GameServer.ts");
const {
  BrowserGameStateRepository,
  InMemoryGameStateRepository,
} = await import("../src/integration/GameStateRepository.ts");

const pose = {
  longitude: 10.75,
  latitude: 59.91,
  elevationMeters: 142.5,
  yaw: 1.2,
  pitch: -0.15,
  movementMode: "walk",
};

test("local server persists a pose and fans it out to sessions in the same world", async () => {
  const repository = new InMemoryGameStateRepository();
  const server = new GameServer(repository, () => 1234);
  const first = new LocalGameConnection(server);
  const second = new LocalGameConnection(server);
  const firstEvents = [];
  const secondEvents = [];
  first.subscribe((event) => firstEvents.push(event));
  second.subscribe((event) => secondEvents.push(event));

  await first.connect({ worldId: "earth", actorId: "alice", sessionId: "session-a" });
  await second.connect({ worldId: "earth", actorId: "bob", sessionId: "session-b" });
  await first.dispatch({ type: "player.pose.update", clientSequence: 0, pose });

  assert.deepEqual(firstEvents, secondEvents);
  assert.deepEqual(firstEvents, [{
    type: "player.pose.changed",
    worldId: "earth",
    actorId: "alice",
    originSessionId: "session-a",
    revision: 1,
    occurredAt: 1234,
    pose,
  }]);
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

test("snapshots restore persisted players and fan-out stays within a world", async () => {
  const repository = new InMemoryGameStateRepository();
  const server = new GameServer(repository);
  const earth = new LocalGameConnection(server);
  await earth.connect({ worldId: "earth", actorId: "alice", sessionId: "earth-a" });
  await earth.dispatch({ type: "player.pose.update", clientSequence: 0, pose });

  const mars = new LocalGameConnection(server);
  const marsEvents = [];
  mars.subscribe((event) => marsEvents.push(event));
  await mars.connect({ worldId: "mars", actorId: "alice", sessionId: "mars-a" });

  await earth.dispatch({
    type: "player.pose.update",
    clientSequence: 1,
    pose: { ...pose, yaw: 2 },
  });
  assert.deepEqual(marsEvents, []);

  const newcomer = new LocalGameConnection(server);
  const snapshot = await newcomer.connect({
    worldId: "earth",
    actorId: "bob",
    sessionId: "earth-b",
  });
  assert.equal(snapshot.players.length, 1);
  assert.equal(snapshot.players[0].pose.yaw, 2);
  assert.equal(snapshot.players[0].revision, 2);
});

test("duplicate and out-of-order client actions are ignored", async () => {
  const repository = new InMemoryGameStateRepository();
  const connection = new LocalGameConnection(new GameServer(repository));
  const events = [];
  connection.subscribe((event) => events.push(event));
  await connection.connect({ worldId: "earth", actorId: "alice", sessionId: "session-a" });

  await connection.dispatch({ type: "player.pose.update", clientSequence: 4, pose });
  await connection.dispatch({
    type: "player.pose.update",
    clientSequence: 3,
    pose: { ...pose, yaw: 3 },
  });

  assert.equal(events.length, 1);
  assert.equal((await repository.loadPlayers("earth"))[0].pose.yaw, pose.yaw);
});

test("disconnecting the final actor session emits departure and hides persisted offline players", async () => {
  const repository = new InMemoryGameStateRepository();
  const server = new GameServer(repository, () => 5678);
  const alice = new LocalGameConnection(server);
  const bob = new LocalGameConnection(server);
  const bobEvents = [];
  bob.subscribe((event) => bobEvents.push(event));
  await alice.connect({ worldId: "earth", actorId: "alice", sessionId: "session-a" });
  await bob.connect({ worldId: "earth", actorId: "bob", sessionId: "session-b" });
  await alice.dispatch({ type: "player.pose.update", clientSequence: 0, pose });

  bobEvents.length = 0;
  await alice.close();
  assert.deepEqual(bobEvents, [{
    type: "player.left",
    worldId: "earth",
    actorId: "alice",
    originSessionId: "session-a",
    occurredAt: 5678,
  }]);

  const newcomer = new LocalGameConnection(server);
  const snapshot = await newcomer.connect({
    worldId: "earth",
    actorId: "charlie",
    sessionId: "session-c",
  });
  assert.deepEqual(snapshot.players, []);
});

test("browser repository survives malformed local data and restores valid state", async () => {
  const storage = new MemoryStorage();
  const repository = new BrowserGameStateRepository(storage);
  storage.value = JSON.stringify({ version: 1, players: { broken: null } });
  assert.deepEqual(await repository.loadPlayers("earth"), []);

  await repository.savePlayer({
    worldId: "earth",
    actorId: "alice",
    revision: 7,
    updatedAt: 1234,
    pose,
  });
  const restored = new BrowserGameStateRepository(storage);
  assert.deepEqual(await restored.loadPlayers("earth"), [{
    worldId: "earth",
    actorId: "alice",
    revision: 7,
    updatedAt: 1234,
    pose,
  }]);
});

test("browser broadcast connections fan poses and departures across independent tabs", async () => {
  const repository = new InMemoryGameStateRepository();
  const channels = new FakeBroadcastHub();
  const alice = new BrowserBroadcastGameConnection(repository, channels.open(), () => 1000);
  const bob = new BrowserBroadcastGameConnection(repository, channels.open(), () => 2000);
  const aliceEvents = [];
  const bobEvents = [];
  alice.subscribe((event) => aliceEvents.push(event));
  bob.subscribe((event) => bobEvents.push(event));

  await alice.connect({ worldId: "earth", actorId: "alice", sessionId: "tab-a" });
  await alice.dispatch({ type: "player.pose.update", clientSequence: 0, pose });
  aliceEvents.length = 0;
  await bob.connect({ worldId: "earth", actorId: "bob", sessionId: "tab-b" });

  assert.equal(bobEvents.length, 1);
  assert.equal(bobEvents[0].actorId, "alice");
  await bob.dispatch({
    type: "player.pose.update",
    clientSequence: 0,
    pose: { ...pose, longitude: 11 },
  });
  assert.equal(aliceEvents.length, 1);
  assert.equal(aliceEvents[0].actorId, "bob");
  assert.equal(aliceEvents[0].pose.longitude, 11);

  aliceEvents.length = 0;
  await bob.close();
  assert.deepEqual(aliceEvents, [{
    type: "player.left",
    worldId: "earth",
    actorId: "bob",
    originSessionId: "tab-b",
    occurredAt: 2000,
  }]);
});

class MemoryStorage {
  value = null;

  getItem() {
    return this.value;
  }

  setItem(_key, value) {
    this.value = value;
  }
}

class FakeBroadcastHub {
  channels = new Set();

  open() {
    const channel = {
      onmessage: null,
      postMessage: (message) => {
        for (const target of this.channels) {
          if (target !== channel) target.onmessage?.({ data: structuredClone(message) });
        }
      },
      close: () => this.channels.delete(channel),
    };
    this.channels.add(channel);
    return channel;
  }
}
