import assert from 'node:assert/strict';
import test from 'node:test';
import { Effect, NullEngine, Scene } from '@babylonjs/core';
import { CustomMaterial } from '@babylonjs/materials/custom/customMaterial.js';
import { shareCustomShader } from '../src/rendering/SharedCustomShader.ts';

test('identical custom shaders share a program key while uniform values and material lifetimes remain independent', () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const create = (value, code = 'result *= scale;') => {
      const m = new CustomMaterial(`scale-${value}`, scene);
      m.AddUniform('scale', 'float', value);
      m.AddAttribute('uv2');
      m.Fragment_Custom_Diffuse(code);
      shareCustomShader(m);
      return m;
    };
    const resolve = m => {
      const uniforms = [], samplers = [], attributes = [];
      const name = m.customShaderNameResolve('default', uniforms, [], samplers, {}, attributes);
      assert.ok(uniforms.includes('scale'));
      assert.ok(attributes.includes('uv2'));
      return name;
    };
    const a = create(1), b = create(2), changed = create(1, 'result += scale;');
    const key = resolve(a);
    assert.equal(resolve(b), key);
    assert.notEqual(resolve(changed), key);
    const values = [];
    for (const m of [a, b]) m.AttachAfterBind(null, { setFloat: (name, value) => values.push([name, value]) });
    assert.deepEqual(values, [['scale', 1], ['scale', 2]]);
    a.dispose();
    assert.ok(scene.materials.includes(b));
    assert.equal(resolve(b), key);
    assert.ok(Effect.ShadersStore[`${key}VertexShader`]);
  } finally { scene.dispose(); engine.dispose(); }
});
