export const vertexShader = `
precision highp float;
attribute vec3 position;
attribute vec2 uv;
uniform mat4 viewProjection;
uniform vec3 center;
uniform vec3 billboardRight;
uniform vec3 billboardUp;
uniform float diameter;
varying vec2 vUV;
void main(void) {
  vec3 worldPosition = center + (billboardRight * position.x + billboardUp * position.y) * diameter;
  gl_Position = viewProjection * vec4(worldPosition, 1.0);
  vUV = vec2(uv.x, 1.0 - uv.y);
}`;
