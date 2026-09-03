import type { BuildingPolygon } from "./BuildingPlanner";
import { worldTileAtLocation, type WorldTileId } from "./WorldGrid";

/**
 * Gives a cross-boundary building to one stable application tile. The
 * north-westernmost outline vertex matches row-major tile traversal while
 * guaranteeing that the owner actually contains part of the source polygon.
 */
export function buildingOwnerWorldTile(
  polygon: BuildingPolygon,
  level: number,
): WorldTileId | undefined {
  const points = withoutClosingPoint(polygon.outer);
  let owner: WorldTileId | undefined;
  for (const [longitude, latitude] of points) {
    const candidate = worldTileAtLocation(latitude, longitude, level);
    if (!owner || candidate.y < owner.y ||
        (candidate.y === owner.y && candidate.x < owner.x)) {
      owner = candidate;
    }
  }
  return owner;
}

export function buildingBelongsToWorldTile(
  polygon: BuildingPolygon,
  tile: WorldTileId,
): boolean {
  const owner = buildingOwnerWorldTile(polygon, tile.level);
  return owner?.x === tile.x && owner.y === tile.y;
}

function withoutClosingPoint(
  ring: BuildingPolygon["outer"],
): BuildingPolygon["outer"] {
  if (ring.length < 2) return ring;
  const first = ring[0];
  const last = ring[ring.length - 1];
  return first[0] === last[0] && first[1] === last[1] ? ring.slice(0, -1) : ring;
}
