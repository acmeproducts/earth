// GPU regression: grass must dim like upward-facing StandardMaterial terrain.
// Run: yarn node --import ./tests/register-typescript.mjs tests/drive-grass-shadow-lighting.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { vegetationLightingFragmentDeclaration } from "../src/vegetation/VegetationLighting.ts";
import { launchBrowser } from "./browser-harness.mjs";

const browser = await launchBrowser([
  "--remote-debugging-port=9353", "--headless=new", "--enable-unsafe-swiftshader",
  "--no-first-run", "about:blank",
]);
try {
  const cases = [
    { sky: 0.55, sun: 2.1, height: 0.9 },
    { sky: 0.35, sun: 1.5, height: 0.5 },
    { sky: 0.16, sun: 0.7, height: 0.1 },
  ];
  const pixels = await browser.evaluate(`(() => {
    const gl = document.createElement('canvas').getContext('webgl');
    const compile = (type, source) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source); gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(shader));
      return shader;
    };
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER,
      'attribute vec2 position; void main() { gl_Position = vec4(position, 0., 1.); }'));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER,
      'precision highp float;\\n' + ${JSON.stringify(vegetationLightingFragmentDeclaration)} +
      'uniform vec3 inputs; uniform float visibility; void main() {' +
      'float direct = (inputs.z + 0.42) / 1.42;' +
      'gl_FragColor = vec4(vegetationLighting(vec3(inputs.x), vec3(inputs.x), vec3(inputs.y),' +
      'inputs.z, direct, visibility, 1.) * 0.4, 1.); }'));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'position');
    gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    gl.viewport(0, 0, 1, 1);
    gl.uniform1f(gl.getUniformLocation(program, 'terrainLighting'), 1);
    return ${JSON.stringify(cases)}.map(c => [1, 0.65, 0.3].map(visibility => {
      gl.uniform3f(gl.getUniformLocation(program, 'inputs'), c.sky, c.sun, c.height);
      gl.uniform1f(gl.getUniformLocation(program, 'visibility'), visibility);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      const pixel = new Uint8Array(4);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      return pixel[0];
    }));
  })()`);
  for (const [index, c] of cases.entries()) {
    const expected = [1, 0.65, 0.3].map(v => Math.round(Math.min(1, c.sky + c.sun * c.height * v) * 0.4 * 255));
    pixels[index].forEach((pixel, i) => assert.ok(Math.abs(pixel - expected[i]) <= 1,
      `case ${index}, shadow ${i}: grass ${pixel}, terrain ${expected[i]}`));
  }
  const grass = readFileSync(new URL('../src/vegetation/GrassField.ts', import.meta.url), 'utf8');
  assert.match(grass, /configureVegetationMaterials\(\[grass, grassModel\], \{\s*floats: \{[^}]*terrainLighting: 1/);
  console.log('Grass GPU lighting matches terrain for sunlit, partial-shadow and full-shadow samples at three sun heights:', pixels);
} finally {
  browser.socket.close();
  browser.chrome.kill();
}
