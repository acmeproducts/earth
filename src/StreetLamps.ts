import {
  Color3,
  Matrix,
  MeshBuilder,
  Quaternion,
  Scene,
  StandardMaterial,
  TransformNode,
  Vector3,
} from "@babylonjs/core";
import { lonLatToScene, sampleElevation } from "./Geo";
import type { RoadsideDetailRoad } from "./OpenStreetMap";
import type { TerrainData } from "./TerrainData";
import { worldTileAtLocation, worldTileBounds, type TileBounds } from "./WorldGrid";

export interface StreetLampFeature {
  id: number;
  lon: number;
  lat: number;
}

interface StreetLampOptions {
  meshWidth: number;
  meshDepth: number;
  metersPerUnit: number;
  startDisabled?: boolean;
}

export interface StreetLampLayer {
  root: TransformNode;
  count: number;
  mappedCount: number;
  proceduralCount: number;
}

const QUERY_ZOOM = 14;
const ENDPOINT = "https://overpass-api.de/api/interpreter";
const cache = new Map<string, Promise<StreetLampFeature[]>>();
const PROCEDURAL_SPACING_METERS = 34;
const MAPPED_CLEARANCE_METERS = 25;

/**
 * Street-lamp nodes are sparse in the vector-tile schema, so this layer uses
 * the authoritative OSM nodes where available and deterministic road-side
 * infill elsewhere. Lamps are emissive geometry rather than PointLights:
 * hundreds of dynamic lights would make streamed tiles prohibitively costly.
 */
export class StreetLamps {
  static fetch(bounds: TileBounds): Promise<StreetLampFeature[]> {
    const tile = worldTileAtLocation(bounds.latNorth - 1e-10, bounds.lonWest + 1e-10, QUERY_ZOOM);
    const key = `${QUERY_ZOOM}/${tile.x}/${tile.y}`;
    let request = cache.get(key);
    if (!request) {
      request = this.fetchRegion(worldTileBounds(tile)).catch((error: unknown) => {
        console.warn(`OSM street lamps unavailable for ${key}; using procedural coverage.`, error);
        return [];
      });
      cache.set(key, request);
    }
    return request;
  }

  static createLayer(
    scene: Scene,
    mapped: readonly StreetLampFeature[],
    roads: readonly RoadsideDetailRoad[],
    terrain: TerrainData,
    options: StreetLampOptions,
  ): StreetLampLayer {
    const root = new TransformNode("streetLamps", scene);
    if (options.startDisabled) root.setEnabled(false);
    const placements: Array<{ x: number; z: number; angle: number }> = [];
    const mappedPositions: Array<{ x: number; z: number }> = [];
    for (const lamp of mapped) {
      const point = lonLatToScene(lamp.lon, lamp.lat, terrain.bounds, options.meshWidth, options.meshDepth);
      if (!inside(point, options)) continue;
      mappedPositions.push(point);
      placements.push({ x: point.x, z: point.z, angle: 0 });
    }

    for (const road of roads) {
      const roadClass = String(road.properties.class ?? "").toLowerCase();
      if (!eligibleRoad(roadClass, road.properties)) continue;
      const roadWidth = roadWidthMeters(roadClass);
      for (const line of road.paths) {
        const points = line.map(([lon, lat]) => lonLatToScene(
          lon, lat, terrain.bounds, options.meshWidth, options.meshDepth,
        ));
        addProceduralLamps(placements, mappedPositions, points, road.id, roadWidth, options);
      }
    }

    if (placements.length > 0) createLampMeshes(scene, root, placements, terrain, options);
    return {
      root,
      count: placements.length,
      mappedCount: mappedPositions.length,
      proceduralCount: placements.length - mappedPositions.length,
    };
  }

  private static async fetchRegion(bounds: TileBounds): Promise<StreetLampFeature[]> {
    const bbox = [bounds.latSouth, bounds.lonWest, bounds.latNorth, bounds.lonEast].join(",");
    const query = `[out:json][timeout:15];node["highway"="street_lamp"](${bbox});out body qt;`;
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: `data=${encodeURIComponent(query)}`,
    });
    if (!response.ok) throw new Error(`Street-lamp request failed (${response.status}).`);
    const body: unknown = await response.json();
    const elements = body && typeof body === "object" && Array.isArray((body as { elements?: unknown[] }).elements)
      ? (body as { elements: unknown[] }).elements : [];
    return elements.flatMap((element): StreetLampFeature[] => {
      if (!element || typeof element !== "object") return [];
      const value = element as { id?: unknown; lat?: unknown; lon?: unknown };
      return typeof value.id === "number" && typeof value.lat === "number" && typeof value.lon === "number"
        ? [{ id: value.id, lat: value.lat, lon: value.lon }] : [];
    });
  }
}

function addProceduralLamps(
  output: Array<{ x: number; z: number; angle: number }>,
  mapped: readonly { x: number; z: number }[],
  points: readonly { x: number; z: number }[],
  roadId: string,
  roadWidth: number,
  options: StreetLampOptions,
): void {
  if (points.length < 2) return;
  const spacing = PROCEDURAL_SPACING_METERS / options.metersPerUnit;
  let distance = (hash(roadId) % 1000) / 1000 * spacing;
  const offset = (roadWidth / 2 + 1.15) / options.metersPerUnit;
  for (let index = 1; index < points.length; index++) {
    const start = points[index - 1];
    const end = points[index];
    const dx = end.x - start.x;
    const dz = end.z - start.z;
    const length = Math.hypot(dx, dz);
    if (length < 0.001) continue;
    while (distance <= length) {
      const t = distance / length;
      // Alternate sides along each centerline; this avoids a rigid boulevard
      // pattern while keeping lamps consistently beyond the carriageway.
      const side = ((Math.floor((distance + index * spacing) / spacing) + hash(roadId)) & 1) ? 1 : -1;
      const x = start.x + dx * t - dz / length * offset * side;
      const z = start.z + dz * t + dx / length * offset * side;
      if (inside({ x, z }, options) && !mapped.some((lamp) =>
        (lamp.x - x) ** 2 + (lamp.z - z) ** 2 < (MAPPED_CLEARANCE_METERS / options.metersPerUnit) ** 2,
      )) output.push({ x, z, angle: Math.atan2(dx, dz) });
      distance += spacing;
    }
    distance -= length;
  }
}

function createLampMeshes(
  scene: Scene,
  root: TransformNode,
  placements: readonly { x: number; z: number; angle: number }[],
  terrain: TerrainData,
  options: StreetLampOptions,
): void {
  const scale = 1 / options.metersPerUnit;
  const pole = MeshBuilder.CreateCylinder("streetLampPoles", { height: 6.4 * scale, diameter: 0.12 * scale, tessellation: 6 }, scene);
  const head = MeshBuilder.CreateSphere("streetLampHeads", { diameter: 0.32 * scale, segments: 8 }, scene);
  const shade = MeshBuilder.CreateCylinder("streetLampShades", {
    height: 0.18 * scale,
    diameterTop: 0.22 * scale,
    diameterBottom: 0.52 * scale,
    tessellation: 10,
  }, scene);
  const poleMaterial = new StandardMaterial("streetLampPoleMaterial", scene);
  poleMaterial.diffuseColor = new Color3(0.075, 0.085, 0.085);
  poleMaterial.specularColor = new Color3(0.12, 0.12, 0.11);
  const headMaterial = new StandardMaterial("streetLampHeadMaterial", scene);
  // The fixtures are deliberately off. A muted lens remains visible without
  // creating the daytime orange glow of an illuminated street lamp.
  headMaterial.diffuseColor = new Color3(0.38, 0.34, 0.25);
  headMaterial.specularColor = new Color3(0.16, 0.13, 0.08);
  const shadeMaterial = new StandardMaterial("streetLampShadeMaterial", scene);
  shadeMaterial.diffuseColor = new Color3(0.045, 0.05, 0.05);
  shadeMaterial.specularColor = new Color3(0.1, 0.11, 0.11);
  pole.material = poleMaterial;
  head.material = headMaterial;
  shade.material = shadeMaterial;
  pole.parent = root;
  head.parent = root;
  shade.parent = root;
  pole.isPickable = false;
  head.isPickable = false;
  shade.isPickable = false;
  // Thin-instance matrices are relative to this source mesh. Keep the source
  // transform at the origin: moving it to hide its base copy would move every
  // lamp below the terrain as well.
  const poleMatrices: Matrix[] = [];
  const headMatrices: Matrix[] = [];
  const shadeMatrices: Matrix[] = [];
  for (const placement of placements) {
    const elevation = sampleElevation(terrain, placement.x, placement.z, options.meshWidth, options.meshDepth) / options.metersPerUnit;
    poleMatrices.push(Matrix.Compose(Vector3.One(), Quaternion.Identity(), new Vector3(placement.x, elevation + 3.2 * scale, placement.z)));
    headMatrices.push(Matrix.Compose(Vector3.One(), Quaternion.Identity(), new Vector3(placement.x, elevation + 6.35 * scale, placement.z)));
    shadeMatrices.push(Matrix.Compose(Vector3.One(), Quaternion.Identity(), new Vector3(placement.x, elevation + 6.53 * scale, placement.z)));
  }
  pole.thinInstanceAdd(poleMatrices);
  head.thinInstanceAdd(headMatrices);
  shade.thinInstanceAdd(shadeMatrices);
}

function eligibleRoad(roadClass: string, properties: Readonly<Record<string, unknown>>): boolean {
  if (["motorway", "trunk", "track", "path"].includes(roadClass)) return false;
  if (String(properties.brunnel ?? "").toLowerCase() !== "") return false;
  return ["primary", "secondary", "tertiary", "minor", "service"].includes(roadClass);
}

function roadWidthMeters(roadClass: string): number {
  return ({ primary: 8, secondary: 7, tertiary: 6, minor: 4, service: 3 } as Record<string, number>)[roadClass] ?? 4;
}

function inside(point: { x: number; z: number }, options: StreetLampOptions): boolean {
  return Math.abs(point.x) <= options.meshWidth / 2 && Math.abs(point.z) <= options.meshDepth / 2;
}

function hash(value: string): number {
  let result = 2166136261;
  for (let index = 0; index < value.length; index++) result = Math.imul(result ^ value.charCodeAt(index), 16777619);
  return result >>> 0;
}
