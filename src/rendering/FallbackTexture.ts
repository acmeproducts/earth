import { RawTexture, Scene, Texture } from "@babylonjs/core";

const fallbackWhiteTextures = new WeakMap<Scene, RawTexture>();

export function fallbackWhiteTexture(scene: Scene): RawTexture {
  const cached = fallbackWhiteTextures.get(scene);
  if (cached) return cached;
  const texture = RawTexture.CreateRGBATexture(
    new Uint8Array([255, 255, 255, 255]),
    1,
    1,
    scene,
    false,
    false,
    Texture.NEAREST_SAMPLINGMODE,
  );
  texture.name = "fallbackWhiteTexture";
  fallbackWhiteTextures.set(scene, texture);
  return texture;
}
