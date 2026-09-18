import { RawTexture, Scene, Texture, Vector2, Vector3, Vector4 } from "@babylonjs/core";
import { cellRandom } from "../core/Random";
import { smoothstep } from "../core/MathUtils";

export const cloudCoverageShader = `
uniform sampler2D cloudPattern;
uniform vec4 cloudField;
uniform vec2 cloudOffset;
float cloudCoverage(vec2 worldXZ) {
  float noise = texture2D(cloudPattern, worldXZ * cloudField.x + cloudOffset).r;
  float threshold = mix(0.82, 0.24, cloudField.y);
  return smoothstep(threshold, threshold + 0.16, noise) * smoothstep(0.0, 0.08, cloudField.y);
}`;

/** Seamless 2D noise, generated once and shared by the sky and ground shadows. */
export function createCloudPattern(seed: number, size = 256): Uint8Array {
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let value = 0;
    for (let octave = 0; octave < 4; octave++) {
      const period = 8 * 2 ** octave;
      const px = x / size * period, py = y / size * period;
      const ix = Math.floor(px), iy = Math.floor(py);
      const tx = smoothstep(0, 1, px - ix), ty = smoothstep(0, 1, py - iy);
      const sample = (dx: number, dy: number): number => cellRandom(seed, (ix + dx) % period, (iy + dy) % period, octave);
      const top = sample(0, 0) * (1 - tx) + sample(1, 0) * tx;
      const bottom = sample(0, 1) * (1 - tx) + sample(1, 1) * tx;
      value += (top * (1 - ty) + bottom * ty) * (0.5333333333 / 2 ** octave);
    }
    const index = (y * size + x) * 4;
    pixels[index] = pixels[index + 1] = pixels[index + 2] = Math.round(value * 255);
    pixels[index + 3] = 255;
  }
  return pixels;
}

export interface CloudField {
  readonly texture: RawTexture;
  readonly parameters: Vector4;
  readonly offset: Vector2;
  readonly sun: Vector3;
  updateSun(direction: Vector3): void;
  dispose(): void;
}

const fields = new WeakMap<Scene, CloudField>();
export function cloudFieldForScene(scene: Scene): CloudField | undefined { return fields.get(scene); }

export function createCloudField(scene: Scene, metersPerUnit: number, seed: number): CloudField {
  fields.get(scene)?.dispose();
  const texture = RawTexture.CreateRGBATexture(createCloudPattern(seed), 256, 256, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE);
  texture.name = "cloudPattern";
  texture.wrapU = texture.wrapV = Texture.WRAP_ADDRESSMODE;
  let disposed = false;
  const field: CloudField = {
    texture, parameters: new Vector4(metersPerUnit / 32_000, 0, 7_000 / metersPerUnit, 0),
    offset: Vector2.Zero(), sun: Vector3.Up(),
    updateSun(direction) {
      field.sun.copyFrom(direction);
      field.parameters.w = smoothstep(0.07, 0.34, direction.y);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      field.parameters.y = field.parameters.w = 0;
      if (fields.get(scene) === field) fields.delete(scene);
      texture.dispose();
      scene.onDisposeObservable.remove(onDispose);
    },
  };
  fields.set(scene, field);
  const onDispose = scene.onDisposeObservable.addOnce(() => field.dispose());
  return field;
}
