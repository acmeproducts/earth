import assert from 'node:assert/strict';
import test from 'node:test';
import { enableWebGLHalfRangeDepth } from '../src/rendering/WebGLDepth.ts';

test('enables matching GPU and Babylon depth ranges and restores GPU state', () => {
  const calls = [];
  const observers = [];
  const extension = { LOWER_LEFT_EXT: 0x8ca1, ZERO_TO_ONE_EXT: 0x935f,
    clipControlEXT: (...args) => calls.push(args) };
  const engine = { isNDCHalfZRange: false,
    _gl: { getExtension: name => { assert.equal(name, 'EXT_clip_control'); return extension; } },
    onContextRestoredObservable: { add: callback => observers.push(callback) } };
  assert.equal(enableWebGLHalfRangeDepth(engine), true);
  assert.equal(engine.isNDCHalfZRange, true);
  assert.deepEqual(calls, [[0x8ca1, 0x935f]]);
  observers[0]();
  assert.deepEqual(calls, [[0x8ca1, 0x935f], [0x8ca1, 0x935f]]);
});

test('retains conventional WebGL depth when clip control is unavailable', () => {
  const engine = { isNDCHalfZRange: false, _gl: { getExtension: () => null },
    onContextRestoredObservable: { add: () => assert.fail('No restoration hook needed') } };
  assert.equal(enableWebGLHalfRangeDepth(engine), false);
  assert.equal(engine.isNDCHalfZRange, false);
});
