import {
  Scene,
  Vector2,
  MeshBuilder,
  Color3,
  HemisphericLight,
  Mesh,
  Texture,
} from '@babylonjs/core';
import { WaterMaterial } from '@babylonjs/materials';

/**
 * Creates a water plane with realistic reflections and waves.
 * @param scene - The Babylon.js scene
 * @param renderListMeshes - Meshes to include in reflection/refraction render list
 * @param options - Configuration options for the water plane
 * @returns The water ground mesh
 */
export function createWaterPlane(
  scene: Scene,
  renderListMeshes: Mesh[],
  options: {
    width?: number;
    height?: number;
    subdivisions?: number;
    elevation?: number;
  } = {}
): Mesh {
  const {
    width = 100,
    height = 100,
    subdivisions = 64,
    elevation = -0.01,
  } = options;

  // Extend slightly beyond the terrain to avoid edge clipping artifacts
  const waterMesh = MeshBuilder.CreateGround(
    'waterMesh',
    { width: width * 1.2, height: height * 1.2, subdivisions },
    scene
  );
  waterMesh.position.y = elevation;

  const water = new WaterMaterial('waterMaterial', scene, new Vector2(512, 512));
  water.bumpTexture = new Texture(
    'https://assets.babylonjs.com/textures/waterbump.png',
    scene
  );

  // Wave properties
  water.windForce = -5;
  water.waveHeight = 0.01;
  water.bumpHeight = 0.01;
  water.waveLength = 0.1;
  water.windDirection = new Vector2(1, 1);

  // Keep one authoritative tint across the water surface.
  const seaColor = new Color3(0.05, 0.2, 0.4);
  const litSeaColor = seaColor.clone();
  const ambientColor = Color3.White();
  water.waterColor = litSeaColor;
  water.waterColor2 = litSeaColor.clone();
  water.colorBlendFactor = 1;
  water.colorBlendFactor2 = 1;

  // At a blend factor of 1 the reflection/refraction render targets have no
  // effect on the final water color. Avoid rendering the whole scene two extra
  // times per frame while retaining animated normals and light highlights.
  water.enableRenderTargets(false);

  // Babylon's WaterMaterial binds scene lights for highlights, but its diffuse
  // water tint bypasses the accumulated light color. Apply the upward-facing
  // hemispheric contribution here so the ocean follows the same changing sky
  // ambient as the terrain and vegetation.
  water.onBindObservable.add(() => {
    const ambient = scene.lights.find((light): light is HemisphericLight => (
      light instanceof HemisphericLight && light.name === 'skyAmbientLight'
    ));
    if (ambient) {
      ambient.diffuse.scaleToRef(
        ambient.isEnabled() ? ambient.intensity : 0,
        ambientColor
      );
    } else {
      ambientColor.setAll(1);
    }
    seaColor.multiplyToRef(ambientColor, litSeaColor);
    water.waterColor2.copyFrom(litSeaColor);
  });

  // Add meshes to the water's render list for reflections/refractions
  for (const mesh of renderListMeshes) {
    water.addToRenderList(mesh);
  }

  waterMesh.material = water;
  waterMesh.isPickable = false;
  waterMesh.freezeWorldMatrix();
  return waterMesh;
}
