import { Color3, DirectionalLight, HemisphericLight, Scene, ShaderMaterial, Vector3 } from "@babylonjs/core";

const black = Color3.Black();
const fallbackSky = new Color3(0.38, 0.42, 0.48);
const fallbackGround = new Color3(0.08, 0.09, 0.07);

export function bindVegetationLighting(material: ShaderMaterial, scene: Scene): void {
  const sun = scene.lights.find((light): light is DirectionalLight =>
    light instanceof DirectionalLight && light.name === "sunLight");
  const ambient = scene.lights.find((light): light is HemisphericLight =>
    light instanceof HemisphericLight && light.name === "skyAmbientLight");
  material.setVector3("sunDirection", sun?.isEnabled() ? sun.direction.scale(-1).normalize() : Vector3.Up());
  material.setColor3("sunColor", sun?.isEnabled() ? sun.diffuse.scale(sun.intensity) : black);
  material.setColor3("skyColor", ambient ? ambient.diffuse.scale(ambient.intensity) : fallbackSky);
  material.setColor3("groundColor", ambient ? ambient.groundColor.scale(ambient.intensity) : fallbackGround);
}
