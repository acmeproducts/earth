import {
  Camera,
  Constants,
  PostProcess,
  ShaderLanguage,
  Texture,
} from "@babylonjs/core";
import "@babylonjs/core/Shaders/imageProcessing.fragment.js";
import "@babylonjs/core/ShadersWGSL/imageProcessing.fragment.js";

export function createToneMappingPass(camera: Camera): PostProcess {
  // ImageProcessingPostProcess makes Babylon's SSR prepass switch scene materials
  // to linear output, leaving our custom shaders in gamma space. Use the same
  // shader in a standalone pass so the composed frame stays consistently gamma.
  // Omitting FROMLINEARSPACE decodes gamma before ACES and encodes it once after.
  return new PostProcess("toneMapping", "imageProcessing", {
    camera,
    size: 1,
    samplingMode: Texture.BILINEAR_SAMPLINGMODE,
    textureType: Constants.TEXTURETYPE_UNSIGNED_BYTE,
    shaderLanguage: camera.getEngine().isWebGPU && !PostProcess.ForceGLSL
      ? ShaderLanguage.WGSL : ShaderLanguage.GLSL,
    defines: "#define IMAGEPROCESSING\n#define TONEMAPPING 2",
  });
}
