import { Color3, Color4, Engine, FreeCamera, MeshBuilder, RenderTargetTexture, Scene, StandardMaterial, Vector3 } from '@babylonjs/core';
import { enableWebGLHalfRangeDepth } from '../../src/rendering/WebGLDepth';

// Run through drive-render-corruption.mjs with EARTH_FIXTURE set to this file.
const probe = window as unknown as { pixelComplete?: boolean; pixelError?: string; pixelResults?: unknown };
void (async () => {
  const results = [];
  for (const halfRange of [false, true]) {
    const canvas = document.createElement('canvas');
    document.body.append(canvas);
    const engine = new Engine(canvas, false, { stencil: false });
    engine.setSize(256, 256);
    engine.useReverseDepthBuffer = true;
    if (halfRange && !enableWebGLHalfRangeDepth(engine)) throw new Error('EXT_clip_control unavailable');
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0, 0, 0, 1);
    const camera = new FreeCamera('camera', new Vector3(0, 100, 0), scene);
    camera.maxZ = 10000;
    camera.setTarget(new Vector3(0, 0, 1000));
    // Draw the higher surface first: equal depth must expose the incorrect red
    // surface instead of hiding the precision loss behind draw order.
    const surfaces = [0.001, 0].map((height, index) => {
      const material = new StandardMaterial(`surface-${index}`, scene);
      material.disableLighting = true;
      material.emissiveColor = index === 0 ? Color3.Green() : Color3.Red();
      const mesh = MeshBuilder.CreateGround(`surface-${index}`, { width: 2000, height: 2000 }, scene);
      mesh.position.set(0, height, 1050);
      mesh.material = material;
      return mesh;
    });
    const target = new RenderTargetTexture('depth-test', 256, scene, false);
    target.renderList = surfaces;
    target.activeCamera = camera;
    await scene.whenReadyAsync();
    for (const samples of [1, 4]) {
      target.samples = samples;
      for (const near of [0.015, 0.02, 0.1, 1]) {
        camera.minZ = near;
        scene.render();
        target.render();
        const pixels = await target.readPixels();
        if (!pixels) throw new Error('No rendered pixels');
        const bytes = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
        let red = 0, green = 0;
        for (let i = 0; i < bytes.length; i += 4) {
          if (bytes[i] > 128 && bytes[i + 1] < 20) red++;
          if (bytes[i + 1] > 128 && bytes[i] < 20) green++;
        }
        results.push({ halfRange, samples, near, red, green });
        if (green + red < 100) throw new Error('Depth test surfaces are not visible');
        if (halfRange && red !== 0) throw new Error(`Lower surface leaked through: ${JSON.stringify(results)}`);
        if (engine._gl.getError()) throw new Error('WebGL error');
      }
    }
    scene.dispose();
    engine.dispose();
    canvas.remove();
  }
  if (!results.some(result => !result.halfRange && result.red > 0)) throw new Error('Baseline did not reproduce precision loss');
  probe.pixelResults = results;
  probe.pixelComplete = true;
})().catch(error => { probe.pixelError = String(error); console.error(error); });
