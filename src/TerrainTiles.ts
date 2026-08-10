import { DynamicTexture, Scene } from "@babylonjs/core";

/**
 * Utility class for fetching and processing AWS Terrain Tiles.
 * https://registry.opendata.aws/terrain-tiles/
 */
export class TerrainTiles {
  private static readonly BASE_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
  private static readonly OPEN_TOPO_MAP_BASE_URL = "https://tile.opentopomap.org";

  /**
   * Converts latitude/longitude to tile coordinates at a given zoom level.
   * @param lat - Latitude in degrees
   * @param lon - Longitude in degrees
   * @param zoom - Zoom level
   * @returns Object with x and y tile coordinates
   */
  static latLonToTile(lat: number, lon: number, zoom: number): { x: number; y: number } {
    const n = Math.pow(2, zoom);
    const x = Math.floor(((lon + 180) / 360) * n);
    const latRad = (lat * Math.PI) / 180;
    const y = Math.floor((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2 * n);
    return { x, y };
  }

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
    tile: { z: number; x: number; y: number },
  ): TerrainResult {
    let minElevation = Infinity;
    let maxElevation = -Infinity;
    for (let i = 0; i < elevations.length; i++) {
      if (elevations[i] < minElevation) minElevation = elevations[i];
      if (elevations[i] > maxElevation) maxElevation = elevations[i];
    }

    console.log(`Terrain tile ${tile.z}/${tile.x}/${tile.y}: elevation range ${minElevation.toFixed(1)}m to ${maxElevation.toFixed(1)}m`);

    return { elevations, minElevation, maxElevation, width, height, tile };
  }

  /**
   * Fetches a Terrarium elevation tile from AWS and returns processed terrain data.
   * Terrarium format encodes elevation as: height = (R × 256 + G + B/256) - 32768
   * @param z - Zoom level (0-15)
   * @param x - Tile X coordinate
   * @param y - Tile Y coordinate
   * @returns Promise that resolves to terrain result with raw elevation data
   */
  static async fetchTile(z: number, x: number, y: number): Promise<TerrainResult> {
    const raw = await this.loadTileElevations(z, x, y);
    return this.processElevations(raw.elevations, raw.width, raw.height, { z, x, y });
  }

  /**
   * Returns the lon/lat bounding box of a tile.
   * @param x - Tile X coordinate
   * @param y - Tile Y coordinate
   * @param zoom - Zoom level
   * @returns Bounding box with west/east longitude and north/south latitude
   */
  static tileBounds(x: number, y: number, zoom: number): TileBounds {
    const n = Math.pow(2, zoom);
    const lonWest = (x / n) * 360 - 180;
    const lonEast = ((x + 1) / n) * 360 - 180;
    const latNorth = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * (180 / Math.PI);
    const latSouth = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n))) * (180 / Math.PI);
    return { lonWest, lonEast, latNorth, latSouth };
  }

  /**
   * Returns the approximate ground size of a tile in meters.
   * @param bounds - The tile bounding box from tileBounds()
   * @returns Width and height in meters
   */
  static tileSizeMeters(bounds: TileBounds): { widthMeters: number; heightMeters: number } {
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

  /**
   * Fetches terrain centered on a given latitude/longitude.
   * Loads a configurable square grid of tiles centered near the coordinate.
   * @param lat - Latitude in degrees
   * @param lon - Longitude in degrees
   * @param zoom - Zoom level (0-15, higher = more detail, smaller area)
   * @param tilesAcross - Source tiles per axis (1-4, default 2)
   * @returns Promise that resolves to terrain result centered on the coordinate
   */
  static async fetchTileAtLocation(
    lat: number,
    lon: number,
    zoom: number,
    tilesAcross = 2,
  ): Promise<TerrainResult> {
    const gridSize = Math.max(1, Math.min(4, Math.round(tilesAcross)));
    const n = Math.pow(2, zoom);

    // Compute fractional tile coordinates
    const fracX = ((lon + 180) / 360) * n;
    const latRad = (lat * Math.PI) / 180;
    const fracY = (1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2 * n;

    const tileX = Math.floor(fracX);
    const tileY = Math.floor(fracY);
    // Choose a grid centered as closely as possible on the requested coordinate.
    const startX = Math.floor(fracX - gridSize / 2 + 0.5);
    const startY = Math.floor(fracY - gridSize / 2 + 0.5);
    const requests = [] as Array<Promise<{ elevations: Float32Array; width: number; height: number }>>;
    for (let row = 0; row < gridSize; row++) {
      for (let column = 0; column < gridSize; column++) {
        requests.push(this.loadTileElevations(zoom, startX + column, startY + row));
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
    const topLeftBounds = this.tileBounds(startX, startY, zoom);
    const bottomRightBounds = this.tileBounds(
      startX + gridSize - 1,
      startY + gridSize - 1,
      zoom,
    );
    const stitchedBounds: TileBounds = {
      lonWest: topLeftBounds.lonWest,
      lonEast: bottomRightBounds.lonEast,
      latNorth: topLeftBounds.latNorth,
      latSouth: bottomRightBounds.latSouth,
    };
    const { widthMeters, heightMeters } = this.tileSizeMeters(stitchedBounds);

    const result = this.processElevations(stitched, stitchedSize, stitchedSize, { z: zoom, x: tileX, y: tileY });
    result.groundWidthMeters = widthMeters;
    result.groundHeightMeters = heightMeters;
    result.sourceTileStart = { z: zoom, x: startX, y: startY };
    result.tilesAcross = gridSize;
    result.bounds = stitchedBounds;
    return result;
  }

  /**
   * Creates a texture from the same OpenTopoMap tile grid used for terrain.
   * The result is deliberately kept separate from the normal terrain pipeline.
   */
  static async createOpenTopoMapTexture(
    scene: Scene,
    terrain: TerrainResult,
  ): Promise<DynamicTexture> {
    const start = terrain.sourceTileStart;
    if (!start) {
      throw new Error("Terrain result does not include its source tile range.");
    }

    const gridSize = terrain.tilesAcross ?? 2;
    const tileUrls: string[] = [];
    for (let row = 0; row < gridSize; row++) {
      for (let column = 0; column < gridSize; column++) {
        tileUrls.push(
          `${this.OPEN_TOPO_MAP_BASE_URL}/${start.z}/${start.x + column}/${start.y + row}.png`,
        );
      }
    }
    const tiles = await Promise.all(tileUrls.map((url) => this.loadImage(url)));
    const tileSize = tiles[0].width;
    const texture = new DynamicTexture(
      "openTopoMapDebugTexture",
      { width: tileSize * gridSize, height: tileSize * gridSize },
      scene,
      false,
    );
    const context = texture.getContext();

    tiles.forEach((tile, index) => {
      context.drawImage(
        tile,
        (index % gridSize) * tileSize,
        Math.floor(index / gridSize) * tileSize,
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

/**
 * Bounding box of a tile in longitude/latitude.
 */
export interface TileBounds {
  /** Western edge longitude in degrees */
  lonWest: number;
  /** Eastern edge longitude in degrees */
  lonEast: number;
  /** Northern edge latitude in degrees */
  latNorth: number;
  /** Southern edge latitude in degrees */
  latSouth: number;
}

/**
 * Result from fetching and processing terrain elevation data.
 */
export interface TerrainResult {
  /** Raw elevation values in meters, row-major (width × height) */
  elevations: Float32Array;
  /** Minimum elevation in meters */
  minElevation: number;
  /** Maximum elevation in meters */
  maxElevation: number;
  /** Grid width in pixels */
  width: number;
  /** Grid height in pixels */
  height: number;
  /** Tile coordinates */
  tile: { z: number; x: number; y: number };
  /** Real-world ground width in meters (if available) */
  groundWidthMeters?: number;
  /** Real-world ground height in meters (if available) */
  groundHeightMeters?: number;
  /** Top-left source tile of the stitched terrain area. */
  sourceTileStart?: { z: number; x: number; y: number };
  /** Number of source tiles stitched along each axis. */
  tilesAcross?: number;
  /** Geographic extent of the stitched terrain. */
  bounds?: TileBounds;
}
