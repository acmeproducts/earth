import type { WorldTileId } from "../world/WorldGrid";

interface NormalTile {
  id: WorldTileId;
  width: number;
  height: number;
  pixels: Uint8Array;
  edges: Uint8Array[];
  update: () => void;
}

/** Shares boundary shading, including corners and boundaries between different LODs. */
export class TerrainNormalEdges {
  private readonly tiles = new Map<string, NormalTile>();

  add(id: WorldTileId, width: number, height: number, pixels: Uint8Array, update: () => void): () => void {
    const tile: NormalTile = { id, width, height, pixels, update, edges: [] };
    for (let edge = 0; edge < 4; edge++) {
      const values = new Uint8Array(this.length(tile, edge) * 4);
      for (let i = 0; i < values.length / 4; i++) {
        const offset = this.offset(tile, edge, i);
        values.set(pixels.subarray(offset, offset + 4), i * 4);
      }
      tile.edges.push(values);
    }
    this.tiles.set(this.key(id), tile);
    this.refresh(id);
    return () => {
      if (this.tiles.get(this.key(id)) !== tile) return;
      this.tiles.delete(this.key(id));
      this.refresh(id);
    };
  }

  private refresh(id: WorldTileId): void {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const tile = this.tiles.get(this.key({ ...id, x: id.x + dx, y: id.y + dy }));
      if (!tile) continue;
      for (let edge = 0; edge < 4; edge++) {
        const neighbor = this.tiles.get(this.key({ ...tile.id,
          x: tile.id.x + (edge === 1 ? 1 : edge === 3 ? -1 : 0),
          y: tile.id.y + (edge === 2 ? 1 : edge === 0 ? -1 : 0),
        }));
        const opposite = (edge + 2) % 4;
        const count = this.length(tile, edge);
        const intervals = Math.min(count, neighbor ? this.length(neighbor, opposite) : count) - 1;
        for (let i = 1; i < count - 1; i++) {
          const position = i / (count - 1) * intervals;
          const lower = Math.floor(position), fraction = position - lower;
          for (let c = 0; c < 4; c++) {
            const shared = (j: number): number => {
              if (j === 0 || j === intervals) {
                return this.corner(tile.id,
                  edge === 1 || (edge % 2 === 0 && j === intervals) ? 1 : 0,
                  edge === 2 || (edge % 2 === 1 && j === intervals) ? 1 : 0, c);
              }
              const t = j / intervals;
              const value = this.sample(tile.edges[edge], t, c);
              return neighbor ? (value + this.sample(neighbor.edges[opposite], t, c)) / 2 : value;
            };
            tile.pixels[this.offset(tile, edge, i) + c] = Math.round(
              shared(lower) * (1 - fraction) + shared(Math.min(intervals, lower + 1)) * fraction);
          }
        }
      }
      for (let cy = 0; cy <= 1; cy++) for (let cx = 0; cx <= 1; cx++) {
        const offset = (cy * (tile.height - 1) * tile.width + cx * (tile.width - 1)) * 4;
        for (let c = 0; c < 4; c++) tile.pixels[offset + c] = Math.round(this.corner(tile.id, cx, cy, c));
      }
      tile.update();
    }
  }

  private corner(id: WorldTileId, cx: number, cy: number, channel: number): number {
    let sum = 0, count = 0;
    for (let oy = 0; oy <= 1; oy++) for (let ox = 0; ox <= 1; ox++) {
      const neighbor = this.tiles.get(this.key({ ...id, x: id.x + cx - ox, y: id.y + cy - oy }));
      if (!neighbor) continue;
      const edge = neighbor.edges[oy === 0 ? 0 : 2];
      sum += edge[ox * (neighbor.width - 1) * 4 + channel];
      count++;
    }
    return sum / count;
  }

  private sample(edge: Uint8Array, t: number, channel: number): number {
    const position = t * (edge.length / 4 - 1);
    const lower = Math.floor(position), upper = Math.min(edge.length / 4 - 1, lower + 1);
    return edge[lower * 4 + channel] + (edge[upper * 4 + channel] - edge[lower * 4 + channel]) * (position - lower);
  }

  private length(tile: NormalTile, edge: number): number {
    return edge % 2 === 0 ? tile.width : tile.height;
  }

  private offset(tile: NormalTile, edge: number, i: number): number {
    if (edge === 0) return i * 4;
    if (edge === 1) return (i * tile.width + tile.width - 1) * 4;
    if (edge === 2) return ((tile.height - 1) * tile.width + i) * 4;
    return i * tile.width * 4;
  }

  private key(id: WorldTileId): string { return `${id.level}/${id.x}/${id.y}`; }
}
