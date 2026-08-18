import { DynamicTexture, Scene } from "@babylonjs/core";
import type { TerrainData } from "./TerrainData";
import type { TileBounds, WorldTileArea } from "./WorldGrid";

/**
 * Utility class for fetching and processing AWS Terrain Tiles.
 * https://registry.opendata.aws/terrain-tiles/
 */
export class TerrainElevationSource {
  private static readonly BASE_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
  private static readonly OPEN_TOPO_MAP_BASE_URL = "https://tile.opentopomap.org";
  private static readonly elevationCache = new Map<string, Promise<{
    elevations: Float32Array;
    width: number;
    height: number;
  }>>();

  /**
   * Loads a single Terrarium tile and decodes RGB to raw elevation values.
   * @param z - Zoom level
   * @param x - Tile X coordinate
   * @param y - Tile Y coordinate
   * @returns Raw elevation data and image dimensions
   */
  private static async loadTileElevations(z: number, x: number, y: number): Promise<{
    elevations: Float32Array;
    width: number;
    height: number;
  }> {
    const key = `${z}/${x}/${y}`;
    const cached = this.elevationCache.get(key);
    if (cached) return cached;

    const request = this.fetchTileElevations(z, x, y).catch((error: unknown) => {
      this.elevationCache.delete(key);
      throw error;
    });
    this.elevationCache.set(key, request);
    return request;
  }

  private static async fetchTileElevations(z: number, x: number, y: number): Promise<{
    elevations: Float32Array;
    width: number;
    height: number;
  }> {
    const url = `${this.BASE_URL}/${z}/${x}/${y}.png`;

    const img = new Image();
    img.crossOrigin = 'anonymous';

    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error(`Failed to load terrain tile: ${url}`));
      img.src = url;
    });

    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0);

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const pixels = imageData.data;

    const elevations = new Float32Array(canvas.width * canvas.height);
    for (let i = 0; i < pixels.length; i += 4) {
      const r = pixels[i];
      const g = pixels[i + 1];
      const b = pixels[i + 2];
      // Terrarium formula: height = (R × 256 + G + B/256) - 32768
      elevations[i / 4] = (r * 256 + g + b / 256) - 32768;
    }

    return { elevations, width: canvas.width, height: canvas.height };
  }

  /**
   * Computes the raw elevation range and retains full precision for direct vertex use.
   */
  private static processElevations(
    elevations: Float32Array,
    width: number,
    height: number,
    description: string,
  ): Pick<TerrainData, "elevations" | "minElevation" | "maxElevation" | "width" | "height"> {
    let minElevation = Infinity;
    let maxElevation = -Infinity;
    for (let i = 0; i < elevations.length; i++) {
      if (elevations[i] < minElevation) minElevation = elevations[i];
      if (elevations[i] > maxElevation) maxElevation = elevations[i];
    }

    console.log(`${description}: elevation range ${minElevation.toFixed(1)}m to ${maxElevation.toFixed(1)}m`);

    return { elevations, minElevation, maxElevation, width, height };
  }

  /**
   * Returns the approximate ground size of a tile in meters.
   * @param bounds - Geographic bounds to measure
   * @returns Width and height in meters
   */
  private static tileSizeMeters(bounds: TileBounds): { widthMeters: number; heightMeters: number } {
    const lonSpanDeg = bounds.lonEast - bounds.lonWest;
    const latSpanDeg = bounds.latNorth - bounds.latSouth;
    const midLat = (bounds.latNorth + bounds.latSouth) / 2;
    const metersPerDegLat = 111_320;
    const metersPerDegLon = 111_320 * Math.cos(midLat * Math.PI / 180);
    return {
      widthMeters: lonSpanDeg * metersPerDegLon,
      heightMeters: latSpanDeg * metersPerDegLat,
    };
  }

  /** Populates an application-owned tile area from the elevation provider. */
  static async fetchWorldArea(area: WorldTileArea): Promise<TerrainData> {
    // The source adapter chooses its own level and determines which provider
    // tiles overlap our requested bounds. The equality with our current grid
    // level is a quality setting, not an identity relationship.
    const sourceLevel = Math.min(15, area.center.level);
    const { northWest: sourceNorthWest, southEast: sourceSouthEast } =
      providerTileRange(area.bounds, sourceLevel);
    const sourceColumns = sourceSouthEast.x - sourceNorthWest.x + 1;
    const sourceRows = sourceSouthEast.y - sourceNorthWest.y + 1;
    if (sourceColumns !== sourceRows) {
      throw new Error("The elevation adapter expected a square source tile range.");
    }
    const gridSize = sourceColumns;
    const startX = sourceNorthWest.x;
    const startY = sourceNorthWest.y;
    const requests = [] as Array<Promise<{ elevations: Float32Array; width: number; height: number }>>;
    for (let row = 0; row < gridSize; row++) {
      for (let column = 0; column < gridSize; column++) {
        requests.push(this.loadTileElevations(sourceLevel, startX + column, startY + row));
      }
    }
    const rawTiles = await Promise.all(requests);
    const tileSize = rawTiles[0].width; // typically 256
    const stitchedSize = tileSize * gridSize;

    // Stitch the tile grid into a single elevation grid.
    const stitched = new Float32Array(stitchedSize * stitchedSize);
    for (let i = 0; i < rawTiles.length; i++) {
      const ox = (i % gridSize) * tileSize;
      const oy = Math.floor(i / gridSize) * tileSize;
      for (let row = 0; row < tileSize; row++) {
        for (let col = 0; col < tileSize; col++) {
          stitched[(oy + row) * stitchedSize + (ox + col)] =
            rawTiles[i].elevations[row * tileSize + col];
        }
      }
    }

    // Compute the real-world ground extent of the stitched area.
    const stitchedBounds = area.bounds;
    const { widthMeters, heightMeters } = this.tileSizeMeters(stitchedBounds);

    const result = this.processElevations(
      stitched,
      stitchedSize,
      stitchedSize,
      `World tile ${area.center.level}/${area.center.x}/${area.center.y}`,
    );
    return {
      ...result,
      groundWidthMeters: widthMeters,
      groundHeightMeters: heightMeters,
      worldTile: area.center,
      generationSeed: area.seed,
      bounds: stitchedBounds,
    };
  }

  /**
   * Creates an OpenTopoMap debug texture for the terrain's geographic bounds.
   * The result is deliberately kept separate from the normal terrain pipeline.
   */
  static async createOpenTopoMapTexture(
    scene: Scene,
    terrain: TerrainData,
  ): Promise<DynamicTexture> {
    const sourceLevel = Math.min(15, terrain.worldTile.level);
    const { northWest, southEast } = providerTileRange(terrain.bounds, sourceLevel);
    const columns = southEast.x - northWest.x + 1;
    const rows = southEast.y - northWest.y + 1;
    const tileUrls: string[] = [];
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        tileUrls.push(
          `${this.OPEN_TOPO_MAP_BASE_URL}/${sourceLevel}/${northWest.x + column}/${northWest.y + row}.png`,
        );
      }
    }
    const tiles = await Promise.all(tileUrls.map((url) => this.loadImage(url)));
    const tileSize = tiles[0].width;
    const texture = new DynamicTexture(
      "openTopoMapDebugTexture",
      { width: tileSize * columns, height: tileSize * rows },
      scene,
      false,
    );
    const context = texture.getContext();

    tiles.forEach((tile, index) => {
      context.drawImage(
        tile,
        (index % columns) * tileSize,
        Math.floor(index / columns) * tileSize,
      );
    });
    texture.update(false);
    // Canvas tiles are drawn north-to-south; ground UVs run in the opposite V direction.
    texture.vScale = -1;
    texture.vOffset = 1;
    return texture;
  }

  private static async loadImage(url: string): Promise<HTMLImageElement> {
    const image = new Image();
    image.crossOrigin = "anonymous";
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error(`Failed to load map tile: ${url}`));
      image.src = url;
    });
    return image;
  }

}

function providerTileRange(
  bounds: TileBounds,
  level: number,
): { northWest: { x: number; y: number }; southEast: { x: number; y: number } } {
  return {
    northWest: providerTileFor(
      bounds.latNorth - 1e-10,
      bounds.lonWest + 1e-10,
      level,
    ),
    southEast: providerTileFor(
      bounds.latSouth + 1e-10,
      bounds.lonEast - 1e-10,
      level,
    ),
  };
}

function providerTileFor(latitude: number, longitude: number, level: number): { x: number; y: number } {
  const scale = 2 ** level;
  const latitudeRadians = latitude * Math.PI / 180;
  return {
    x: Math.floor((longitude + 180) / 360 * scale),
    y: Math.floor((1 - Math.asinh(Math.tan(latitudeRadians)) / Math.PI) / 2 * scale),
  };
}
