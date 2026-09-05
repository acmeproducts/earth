export class GameServer {
  constructor(repository, now = Date.now) {
    this.repository = repository;
    this.now = now;
    this.sessions = new Map();
  }

  async connect(request, listener) {
    if (!request?.worldId || !request?.actorId || !request?.sessionId) throw new Error("A world, actor, and session are required.");
    if (this.sessions.has(request.sessionId)) throw new Error("The session is already connected.");
    this.sessions.set(request.sessionId, {
      ...request,
      listener,
      lastClientSequence: -1,
      dispatchQueue: Promise.resolve(),
    });
    let players;
    try {
      players = await this.repository.loadPlayers(request.worldId);
    } catch (error) {
      this.sessions.delete(request.sessionId);
      throw error;
    }
    const connectedActors = new Set([...this.sessions.values()]
      .filter((session) => session.worldId === request.worldId)
      .map((session) => session.actorId));
    return {
      worldId: request.worldId,
      players: players.filter((player) => connectedActors.has(player.actorId)).map(clonePlayerState),
    };
  }

  dispatch(sessionId, action) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("The game session is not connected.");
    const dispatched = session.dispatchQueue.then(() => this.dispatchInOrder(session, action));
    session.dispatchQueue = dispatched.catch(() => undefined);
    return dispatched;
  }

  async dispatchInOrder(session, action) {
    if (!Number.isSafeInteger(action?.clientSequence) || action.clientSequence < 0) throw new Error("Invalid client sequence.");
    if (action.clientSequence <= session.lastClientSequence) return;
    if (action.type !== "player.pose.update" || !isValidPlayerPose(action.pose)) throw new Error("Invalid player pose.");
    const players = await this.repository.loadPlayers(session.worldId);
    const previous = players.find((player) => player.actorId === session.actorId);
    const occurredAt = this.now();
    const state = {
      worldId: session.worldId, actorId: session.actorId, pose: { ...action.pose },
      temperature: previous?.temperature ?? 37, hunger: previous?.hunger ?? 100, thirst: previous?.thirst ?? 100,
      revision: (previous?.revision ?? 0) + 1, updatedAt: occurredAt,
    };
    await this.repository.savePlayer(state);
    session.lastClientSequence = action.clientSequence;
    this.broadcast(session.worldId, { type: "player.pose.changed", worldId: state.worldId, actorId: state.actorId,
      originSessionId: session.sessionId, revision: state.revision, occurredAt, pose: state.pose });
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
    for (const session of this.sessions.values()) {
      if (session.worldId !== worldId) continue;
      try {
        session.listener(cloneEvent(event));
      } catch (error) {
        console.error(`Game event listener failed for session ${session.sessionId}.`, error);
      }
    }
  }
}

function isValidPlayerPose(pose) {
  return pose && Number.isFinite(pose.longitude) && Math.abs(pose.longitude) <= 180
    && Number.isFinite(pose.latitude) && Math.abs(pose.latitude) <= 85.05112878
    && Number.isFinite(pose.elevationMeters) && Number.isFinite(pose.yaw)
    && Number.isFinite(pose.pitch) && (pose.movementMode === "fly" || pose.movementMode === "walk");
}

function clonePlayerState(state) {
  return { ...state, pose: { ...state.pose } };
}

function cloneEvent(event) {
  return event.type === "player.pose.changed" ? { ...event, pose: { ...event.pose } } : { ...event };
}
