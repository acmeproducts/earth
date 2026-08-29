export class GameServer {
  constructor(repository, now = Date.now) {
    this.repository = repository;
    this.now = now;
    this.sessions = new Map();
  }

  async connect(request, listener) {
    if (!request?.worldId || !request?.actorId || !request?.sessionId) throw new Error("A world, actor, and session are required.");
    if (this.sessions.has(request.sessionId)) throw new Error("The session is already connected.");
    this.sessions.set(request.sessionId, { ...request, listener, lastClientSequence: -1 });
    const players = await this.repository.loadPlayers(request.worldId);
    const connectedActors = new Set([...this.sessions.values()]
      .filter((session) => session.worldId === request.worldId)
      .map((session) => session.actorId));
    return { worldId: request.worldId, players: players.filter((player) => connectedActors.has(player.actorId)) };
  }

  async dispatch(sessionId, action) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("The game session is not connected.");
    if (!Number.isSafeInteger(action.clientSequence) || action.clientSequence < 0) throw new Error("Invalid client sequence.");
    if (action.clientSequence <= session.lastClientSequence) return;
    session.lastClientSequence = action.clientSequence;
    if (action.type !== "player.pose.update") return;
    const players = await this.repository.loadPlayers(session.worldId);
    const previous = players.find((player) => player.actorId === session.actorId);
    const state = {
      worldId: session.worldId, actorId: session.actorId, pose: action.pose,
      temperature: previous?.temperature ?? 37, hunger: previous?.hunger ?? 100, thirst: previous?.thirst ?? 100,
      revision: (previous?.revision ?? 0) + 1, updatedAt: this.now(),
    };
    await this.repository.savePlayer(state);
    this.broadcast(session.worldId, { type: "player.pose.changed", worldId: state.worldId, actorId: state.actorId,
      originSessionId: session.sessionId, revision: state.revision, occurredAt: state.updatedAt, pose: state.pose });
  }

  disconnect(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    if ([...this.sessions.values()].some((candidate) => candidate.worldId === session.worldId && candidate.actorId === session.actorId)) return;
    this.broadcast(session.worldId, { type: "player.left", worldId: session.worldId, actorId: session.actorId,
      originSessionId: session.sessionId, occurredAt: this.now() });
  }

  broadcast(worldId, event) {
    for (const session of this.sessions.values()) if (session.worldId === worldId) session.listener(event);
  }
}
