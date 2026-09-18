import assert from 'node:assert/strict';
import test from 'node:test';
import { FxaaPostProcess, NullEngine, PrePassRenderer, Scene, UniversalCamera, Vector3 } from '@babylonjs/core';
import { createToneMappingPass } from '../src/rendering/ToneMapping.ts';

test('tone mapping accepts existing gamma output without changing scene materials or captures', () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const camera = new UniversalCamera('camera', Vector3.Zero(), scene);
    const configuration = scene.imageProcessingConfiguration;
    const pass = createToneMappingPass(camera);
    const fxaa = new FxaaPostProcess('FXAA', 1, camera);
    // SSR uses this detector during rendering, after the pass constructor runs.
    // A private ImageProcessingConfiguration alone does not prevent the switch.
    assert.equal(PrePassRenderer.prototype._hasImageProcessing.call({}, [pass, fxaa]), false);
    assert.equal(configuration.applyByPostProcess, false);
    assert.equal(configuration.toneMappingEnabled, false);
    assert.deepEqual(camera._postProcesses.filter(Boolean), [pass, fxaa]);
    fxaa.dispose(camera);
    pass.dispose(camera);
    const replacement = createToneMappingPass(camera);
    assert.deepEqual(camera._postProcesses.filter(Boolean), [replacement]);
    assert.equal(configuration.applyByPostProcess, false);
  } finally {
    scene.dispose();
    engine.dispose();
  }
});
