import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export class SqliteGameStateRepository {
  constructor(filename = "./data/earth.sqlite") {
    mkdirSync(dirname(filename), { recursive: true });
    this.database = new DatabaseSync(filename);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS player_state (
        world_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        pose_json TEXT NOT NULL,
        temperature REAL NOT NULL DEFAULT 37,
        hunger REAL NOT NULL DEFAULT 100,
        thirst REAL NOT NULL DEFAULT 100,
        revision INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (world_id, actor_id)
      )
    `);
    this.loadStatement = this.database.prepare(
      "SELECT world_id, actor_id, pose_json, temperature, hunger, thirst, revision, updated_at FROM player_state WHERE world_id = ?",
    );
    this.saveStatement = this.database.prepare(`
      INSERT INTO player_state
        (world_id, actor_id, pose_json, temperature, hunger, thirst, revision, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(world_id, actor_id) DO UPDATE SET
        pose_json = excluded.pose_json,
        temperature = excluded.temperature,
        hunger = excluded.hunger,
        thirst = excluded.thirst,
        revision = excluded.revision,
        updated_at = excluded.updated_at
    `);
  }

  async loadPlayers(worldId) {
    return this.loadStatement.all(worldId).map((row) => ({
      worldId: row.world_id,
      actorId: row.actor_id,
      pose: JSON.parse(row.pose_json),
      temperature: row.temperature,
      hunger: row.hunger,
      thirst: row.thirst,
      revision: row.revision,
      updatedAt: row.updated_at,
    }));
  }

  async savePlayer(state) {
    this.saveStatement.run(
      state.worldId,
      state.actorId,
      JSON.stringify(state.pose),
      state.temperature,
      state.hunger,
      state.thirst,
      state.revision,
      state.updatedAt,
    );
  }

  close() {
    this.database.close();
  }
}
