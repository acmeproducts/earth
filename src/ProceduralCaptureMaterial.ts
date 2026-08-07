import { Scene, ShaderMaterial } from "@babylonjs/core";

/** Writes generated vertex colors directly into an impostor capture target. */
export function createVertexColorCaptureMaterial(
  scene: Scene,
  name: string,
): ShaderMaterial {
  const material = new ShaderMaterial(
    name,
    scene,
    {
      vertexSource: `
        precision highp float;
        attribute vec3 position;
        attribute vec4 color;
        uniform mat4 viewProjection;
        #include<instancesDeclaration>
        varying vec4 vColor;
        void main(void) {
          #include<instancesVertex>
          vColor = color;
          gl_Position = viewProjection * finalWorld * vec4(position, 1.0);
        }
      `,
      fragmentSource: `
        precision highp float;
        varying vec4 vColor;
        void main(void) {
          gl_FragColor = vec4(vColor.rgb, 1.0);
        }
      `,
    },
    {
      attributes: ["position", "color"],
      uniforms: ["world", "viewProjection"],
      needAlphaBlending: false,
    },
  );
  material.backFaceCulling = false;
  return material;
}
