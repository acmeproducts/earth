import { Mesh, ShaderMaterial, Vector3, VertexBuffer } from "@babylonjs/core";
import { createFrameBudgetYielder } from "./FrameBudget";

export interface AlphaCutout { width: number; height: number; data: Uint8ClampedArray; }
export interface ExposureGeometry {
  positions: ArrayLike<number>;
  indices: ArrayLike<number>;
  uvs: ArrayLike<number>;
  cutout?: AlphaCutout;
}

/** Preserve all four data channels while converting GPU rows to atlas orientation. */
export function packExposureFace(target: Uint8Array, pixels: Uint8Array, face: number, width: number, height: number): void {
  const offsetX = (face % 3) * width, offsetY = Math.floor(face / 3) * height;
  for (let y = 0; y < height; y++) {
    const source = (height - 1 - y) * width * 4;
    target.set(pixels.subarray(source, source + width * 4), ((offsetY + y) * width * 3 + offsetX) * 4);
  }
}

// RGBA = east, north, west, south at 20 and 65 degrees above the horizon.
export const EXPOSURE_ELEVATIONS = [20, 65] as const;
export const EXPOSURE_DIRECTIONS = EXPOSURE_ELEVATIONS.flatMap((elevation) =>
  [0, Math.PI / 2, Math.PI, Math.PI * 1.5].map((azimuth) => {
    const angle = elevation * Math.PI / 180;
    return new Vector3(Math.cos(azimuth) * Math.cos(angle), Math.sin(angle), Math.sin(azimuth) * Math.cos(angle));
  }),
);

let enabled = true;
export function isDirectionalExposureEnabled(): boolean { return enabled; }
export function setDirectionalExposureEnabled(value: boolean): void { enabled = value; }
export function bindDirectionalExposure(material: ShaderMaterial): void {
  material.options.uniforms.push("directionalExposureEnabled");
  material.setFloat("directionalExposureEnabled", enabled ? 1 : 0);
  material.onBindObservable.add(() => material.setFloat("directionalExposureEnabled", enabled ? 1 : 0));
}

export const directionalExposureDeclaration = `
uniform float directionalExposureEnabled;
float directionalExposure(vec4 lowExposure, vec4 highExposure, vec3 sun) {
  float azimuth = mod(atan(sun.z, sun.x) / 1.57079632679 + 4.0, 4.0);
  vec4 weights = max(vec4(0.0), vec4(1.0) - min(
    abs(vec4(azimuth) - vec4(0.0, 1.0, 2.0, 3.0)),
    4.0 - abs(vec4(azimuth) - vec4(0.0, 1.0, 2.0, 3.0))
  ));
  float elevation = asin(clamp(sun.y, -1.0, 1.0));
  float highBlend = clamp((elevation - 0.3490658504) / 0.7853981634, 0.0, 1.0);
  // Azimuth is undefined overhead; converge toward the average of the top samples.
  weights = mix(weights, vec4(0.25), smoothstep(1.134464014, 1.570796327, elevation));
  return dot(mix(lowExposure, highExposure, highBlend), weights);
}
float exposureSunlightScale(float exposure) {
  // Ambient light stays intact. Exposed foliage gets a small lift; interiors lose direct light.
  return mix(1.0, mix(0.18, 1.22, exposure), directionalExposureEnabled);
}
`;

const leafUrls = new WeakMap<ShaderMaterial, string>();
const cutouts = new Map<string, Promise<AlphaCutout>>();
export function registerExposureCutout(material: ShaderMaterial, url?: string): void {
  if (url) leafUrls.set(material, url);
}

async function loadCutout(url: string): Promise<AlphaCutout> {
  let pending = cutouts.get(url);
  if (!pending) {
    pending = new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        resolve(context.getImageData(0, 0, canvas.width, canvas.height));
      };
      image.onerror = () => reject(new Error(`Could not load exposure cutout: ${url}`));
      image.src = url;
    });
    cutouts.set(url, pending);
  }
  return pending;
}

/** Alpha-tested orthographic depth bake; output is eight visibility values per vertex. */
export async function bakeExposureGeometry(
  geometry: readonly ExposureGeometry[],
  resolution = 256,
  yieldWork: () => Promise<void> = async () => {},
): Promise<Float32Array[]> {
  const output = geometry.map((mesh) => new Float32Array(mesh.positions.length / 3 * 8).fill(1));
  let radius = 0;
  for (const mesh of geometry) for (let i = 0; i < mesh.positions.length; i += 3) {
    radius = Math.max(radius, Math.hypot(mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]));
  }
  radius = Math.max(radius * 1.02, 0.001);
  const scale = (resolution - 1) / (2 * radius);
  const bias = 1.5 / scale;
  for (let directionIndex = 0; directionIndex < 8; directionIndex++) {
    const sun = EXPOSURE_DIRECTIONS[directionIndex];
    const right = Vector3.Cross(Vector3.Up(), sun).normalize();
    const up = Vector3.Cross(sun, right).normalize();
    const projected = geometry.map((mesh) => {
      const points = new Float32Array(mesh.positions.length);
      for (let i = 0; i < points.length; i += 3) {
        const x = mesh.positions[i], y = mesh.positions[i + 1], z = mesh.positions[i + 2];
        points[i] = (x * right.x + y * right.y + z * right.z + radius) * scale;
        points[i + 1] = (x * up.x + y * up.y + z * up.z + radius) * scale;
        points[i + 2] = x * sun.x + y * sun.y + z * sun.z;
      }
      return points;
    });
    const depth = new Float32Array(resolution * resolution).fill(-Infinity);
    for (let m = 0; m < geometry.length; m++) {
      const mesh = geometry[m], points = projected[m];
      for (let t = 0; t < mesh.indices.length; t += 3) {
        const ids = [mesh.indices[t], mesh.indices[t + 1], mesh.indices[t + 2]];
        const [a, b, c] = ids.map((id) => id * 3);
        const ax = points[a], ay = points[a + 1], bx = points[b], by = points[b + 1], cx = points[c], cy = points[c + 1];
        const area = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
        if (Math.abs(area) < 1e-8) continue;
        const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
        const maxX = Math.min(resolution - 1, Math.ceil(Math.max(ax, bx, cx)));
        const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)));
        const maxY = Math.min(resolution - 1, Math.ceil(Math.max(ay, by, cy)));
        const leaf = ids.every((id) => mesh.uvs[id * 2] >= 0 && mesh.uvs[id * 2] < 1.5);
        for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
          const wa = ((by - cy) * (x + 0.5 - cx) + (cx - bx) * (y + 0.5 - cy)) / area;
          const wb = ((cy - ay) * (x + 0.5 - cx) + (ax - cx) * (y + 0.5 - cy)) / area;
          const wc = 1 - wa - wb;
          if (Math.min(wa, wb, wc) < 0) continue;
          if (leaf && mesh.cutout) {
            const u = wa * mesh.uvs[ids[0] * 2] + wb * mesh.uvs[ids[1] * 2] + wc * mesh.uvs[ids[2] * 2];
            const v = wa * mesh.uvs[ids[0] * 2 + 1] + wb * mesh.uvs[ids[1] * 2 + 1] + wc * mesh.uvs[ids[2] * 2 + 1];
            const tx = Math.min(mesh.cutout.width - 1, Math.max(0, Math.floor(u * mesh.cutout.width)));
            const ty = Math.min(mesh.cutout.height - 1, Math.max(0, Math.floor(v * mesh.cutout.height)));
            if (mesh.cutout.data[(ty * mesh.cutout.width + tx) * 4 + 3] < 128) continue;
          }
          const offset = y * resolution + x;
          depth[offset] = Math.max(depth[offset], wa * points[a + 2] + wb * points[b + 2] + wc * points[c + 2]);
        }
        if (t % 192 === 0) await yieldWork();
      }
    }
    for (let m = 0; m < geometry.length; m++) {
      const mesh = geometry[m], points = projected[m];
      const sums = new Float32Array(points.length / 3), counts = new Uint16Array(points.length / 3);
      for (let t = 0; t < mesh.indices.length; t += 3) {
        const ids = [mesh.indices[t], mesh.indices[t + 1], mesh.indices[t + 2]];
        const center = [0, 1, 2].map((axis) => ids.reduce((sum, id) => sum + points[id * 3 + axis], 0) / 3);
        for (const id of ids) {
          // Sample inside each triangle rather than on transparent card corners.
          const x = points[id * 3] * 0.35 + center[0] * 0.65;
          const y = points[id * 3 + 1] * 0.35 + center[1] * 0.65;
          const z = points[id * 3 + 2] * 0.35 + center[2] * 0.65;
          let visibility = 0;
          for (const dx of [-0.5, 0.5]) for (const dy of [-0.5, 0.5]) {
            const px = Math.max(0, Math.min(resolution - 1, Math.floor(x + dx)));
            const py = Math.max(0, Math.min(resolution - 1, Math.floor(y + dy)));
            visibility += depth[py * resolution + px] <= z + bias ? 0.25 : 0;
          }
          sums[id] += visibility;
          counts[id]++;
        }
        if (t % 384 === 0) await yieldWork();
      }
      for (let v = 0; v < counts.length; v++) if (counts[v]) output[m][v * 8 + directionIndex] = sums[v] / counts[v];
    }
    await yieldWork();
  }
  return output;
}

export async function bakeTreeExposure(meshes: readonly Mesh[]): Promise<void> {
  const geometry = await Promise.all(meshes.map(async (mesh): Promise<ExposureGeometry> => {
    const url = mesh.material instanceof ShaderMaterial ? leafUrls.get(mesh.material) : undefined;
    return {
      positions: mesh.getVerticesData(VertexBuffer.PositionKind)!,
      indices: mesh.getIndices()!,
      uvs: mesh.getVerticesData(VertexBuffer.UVKind)!,
      cutout: url ? await loadCutout(url) : undefined,
    };
  }));
  const baked = await bakeExposureGeometry(geometry, 256, createFrameBudgetYielder());
  meshes.forEach((mesh, index) => {
    const source = baked[index];
    for (let band = 0; band < 2; band++) {
      const values = new Float32Array(source.length / 2);
      for (let v = 0; v < source.length / 8; v++) values.set(source.subarray(v * 8 + band * 4, v * 8 + band * 4 + 4), v * 4);
      mesh.setVerticesData(band ? "sunExposureHigh" : "sunExposureLow", values, false, 4);
    }
    if (mesh.material instanceof ShaderMaterial && !mesh.material.options.defines.includes("#define TREE_EXPOSURE")) {
      mesh.material.options.defines.push("#define TREE_EXPOSURE");
      mesh.material.options.attributes.push("sunExposureLow", "sunExposureHigh");
    }
  });
}
