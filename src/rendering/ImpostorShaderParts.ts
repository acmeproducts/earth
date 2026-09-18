export const bayer4Shader = `float bayer4(vec2 pixel) {
  vec2 p = mod(floor(pixel), 4.0);
  vec2 low = mod(p, 2.0);
  vec2 high = floor(p * 0.5);
  float lowValue = 2.0 * low.x + low.y * (3.0 - 4.0 * low.x);
  float highValue = 2.0 * high.x + high.y * (3.0 - 4.0 * high.x);
  return (4.0 * lowValue + highValue) / 16.0;
}`;

export function atlasSamplerShader(name: string, texturePrefix: string, face = "face"): string {
  const parameter = face === "face" ? "float face, " : "";
  const branches = Array.from({ length: 4 }, (_, index) =>
    `  if (${face} < ${index}.5) return texture2D(${texturePrefix}${index}, uv);`).join("\n");
  return `vec4 ${name}(${parameter}vec2 uv) {
${branches}
  return texture2D(${texturePrefix}4, uv);
}`;
}
