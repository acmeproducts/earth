import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { NullEngine, Scene } from "@babylonjs/core";

register("./ts-extension-resolver.mjs", import.meta.url);
const { PlayerPresence } = await import("../src/integration/PlayerPresence.ts");

const basePose = {
  longitude: 10,
  latitude: 60,
  elevationMeters: 10,
  yaw: 0,
  pitch: 0,
  movementMode: "walk",
};

test("player presence owns remote marker creation, updates, and removal", async () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const connection = new FakeConnection({
    worldId: "earth",
    players: [
      player("alice", { ...basePose, longitude: 10.1 }),
      player("bob", basePose),
    ],
  });
  const presence = new PlayerPresence(scene, {
    connection,
    worldId: "earth",
    actorId: "alice",
    sessionId: "session-a",
  });

  const session = await presence.connect({ lat: 1, lon: 2 });
  assert.deepEqual(session.location, { lat: 60, lon: 10.1 });
  presence.setWorldFrame({
    bounds: { lonWest: 9, lonEast: 11, latNorth: 61, latSouth: 59 },
    meshWidth: 20,
    meshDepth: 20,
  }, 2);

  assert.equal(scene.getMeshByName("remote-player-alice"), null);
  const marker = scene.getMeshByName("remote-player-bob");
  assert.ok(marker);
  assert.equal(marker.position.y, 5);
  assert.equal(marker.scaling.x, 0.6);
  assert.deepEqual(marker.material.diffuseColor.asArray(), [1, 0, 0]);

  connection.emit({
    type: "player.pose.changed",
    worldId: "earth",
    actorId: "bob",
    originSessionId: "session-b",
    revision: 2,
    occurredAt: 2000,
    pose: { ...basePose, longitude: 10.5 },
  });
  assert.ok(marker.position.x > 0);

  connection.emit({
    type: "player.left",
    worldId: "earth",
    actorId: "bob",
    originSessionId: "session-b",
    occurredAt: 3000,
  });
  assert.equal(scene.getMeshByName("remote-player-bob"), null);

  presence.dispose();
  assert.equal(connection.closed, true);
  scene.dispose();
  engine.dispose();
});

function player(actorId, pose) {
  return {
    worldId: "earth",
    actorId,
    pose,
    revision: 1,
    updatedAt: 1000,
  };
}

class FakeConnection {
  listener = undefined;
  closed = false;

  constructor(snapshot) {
    this.snapshot = snapshot;
  }

  async connect() {
    return this.snapshot;
  }

  async dispatch() {}

  subscribe(listener) {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }

  async close() {
    this.closed = true;
  }

  emit(event) {
    this.listener?.(event);
  }
}
