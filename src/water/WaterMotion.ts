import { MaterialPluginBase, PBRMaterial, ShaderLanguage } from '@babylonjs/core';
import type { Material, UniformBuffer } from '@babylonjs/core';
import type { WaterProfile } from './WaterProfile';
import { waterFrame } from './WaterFrame';

/** One wave clock drives surface height, shore run-up, shading and foam. */
export class WaterMotionPlugin extends MaterialPluginBase {
  readonly metersPerUnit: number;
  readonly profile: WaterProfile;

  constructor(material: Material, metersPerUnit: number, profile: WaterProfile) {
    super(material, 'WaterMotion', 200, {}, true, true);
    this.metersPerUnit = metersPerUnit;
    this.profile = profile;
  }

  isCompatible(): boolean { return true; }
  getAttributes(attributes: string[]): void { attributes.push('waterShore'); }

  getUniforms(language = ShaderLanguage.GLSL) {
    const declaration = language === ShaderLanguage.WGSL
      ? 'uniform waterState: vec4f; uniform waterShape: vec4f;'
      : 'uniform vec4 waterState; uniform vec4 waterShape;';
    return {
      ubo: [{ name: 'waterState', size: 4, type: 'vec4' }, { name: 'waterShape', size: 4, type: 'vec4' }],
      vertex: declaration, fragment: declaration,
    };
  }

  bindForSubMesh(buffer: UniformBuffer): void {
    const frame = waterFrame(this._material.getScene());
    buffer.updateFloat4('waterState', frame.seconds,
      Math.min(1, Math.max(0, frame.wind.strength)), this.metersPerUnit,
      Math.PI * 2 / this.profile.periodSeconds);
    buffer.updateFloat4('waterShape', this.profile.heaveMeters, this.profile.crestMeters,
      this.profile.foamStrength, this.profile.troughMeters);
  }

  getCustomCode(type: string, language = ShaderLanguage.GLSL): Record<string, string> | null {
    const wgsl = language === ShaderLanguage.WGSL;
    const state = wgsl ? 'uniforms.waterState' : 'waterState';
    const shape = wgsl ? 'uniforms.waterShape' : 'waterShape';
    const eye = wgsl ? 'scene.vEyePosition' : 'vEyePosition';
    const vec = (size: number) => wgsl ? `vec${size}f` : `vec${size}`;
    const variable = (name: string, value: string, size = 1) => wgsl
      ? `var ${name}: ${size === 1 ? 'f32' : vec(size)} = ${value};`
      : `${size === 1 ? 'float' : vec(size)} ${name} = ${value};`;
    const varying = wgsl
      ? 'varying vWaterWave: vec4f; varying vWaterShore: f32;'
      : 'varying vec4 vWaterWave; varying float vWaterShore;';
    if (type === 'vertex') {
      const shore = wgsl ? 'vertexInputs.waterShore' : 'waterShore';
      const output = wgsl ? 'vertexOutputs.' : '';
      // Displace before native world/prepass calculations, so depth, reflection,
      // fog and shadow coordinates all describe the same moving surface.
      return {
        CUSTOM_VERTEX_DEFINITIONS: varying + (wgsl
          ? 'attribute waterShore: vec2f;' : 'attribute vec2 waterShore;'),
        CUSTOM_VERTEX_UPDATE_POSITION: [
          wgsl
            ? `#ifdef WORLD_UBO\n${variable('waterWorld', 'mesh.world * vec4f(positionUpdated, 1.0)', 4)}\n#else\n${variable('waterWorld', 'uniforms.world * vec4f(positionUpdated, 1.0)', 4)}\n#endif`
            : variable('waterWorld', 'world * vec4(positionUpdated, 1.0)', 4),
          variable('waterP', `waterWorld.xz * ${state}.z`, 2),
          variable('waterD', `${shore}.x * 8.0`),
          variable('waterPhase', `${state}.x * ${state}.w`),
          variable('waterBand', `smoothstep(-12.0, -7.0, waterD) * (1.0 - smoothstep(1.6, 3.2, waterD)) * ${shore}.y`),
          variable('waterFade', `1.0 - smoothstep(180.0, 350.0, length(${eye}.xyz - waterWorld.xyz) * ${state}.z)`),
          variable('waterCrest', 'pow(max(0.0, sin(waterPhase - waterD * 1.15)), 3.0) * waterBand * waterFade'),
          variable('waterCycle', 'sin(waterPhase)'),
          variable('waterHeave', `waterCycle * mix(${shape}.w, ${shape}.x, step(0.0, waterCycle))`),
          variable('waterLift', `(waterHeave + waterCrest * ${shape}.y) * ${state}.y`),
          `positionUpdated.y += waterLift / ${state}.z;`,
          `${output}vWaterWave = ${vec(4)}(${shore}.x, waterLift, waterCrest, ${shore}.y * waterFade);`,
          `${output}vWaterShore = ${shore}.y;`,
          // Texture coordinates are physical metres and identical on ocean,
          // shore and lake meshes, regardless of their dimensions or offsets.
          this.profile?.currentMetersPerSecond === undefined
            ? `#ifdef UV1\nuvUpdated = ${vec(2)}(waterP.x, -waterP.y);\n#endif`
            : '',
        ].join('\n'),
      };
    }
    if (type !== 'fragment') return null;
    const wave = wgsl ? 'fragmentInputs.vWaterWave' : 'vWaterWave';
    const shore = wgsl ? 'fragmentInputs.vWaterShore' : 'vWaterShore';
    const world = wgsl ? 'fragmentInputs.vPositionW' : 'vPositionW';
    const dx = wgsl ? 'dpdx' : 'dFdx';
    const dy = wgsl ? 'dpdy' : 'dFdy';
    const common = [
      variable('waterP', `${world}.xz * ${state}.z`, 2),
      variable('waterGrain', `0.5 + 0.25 * sin(waterP.x * 3.1 + sin(waterP.y * 2.7) + ${state}.x * 0.45) + 0.25 * sin(waterP.y * 4.3 - waterP.x * 1.7)`),
      // Foam comes from the *interpolated displaced crest*, never from an
      // independently animated line that can slide off the visible wave.
      variable('waterFoam', `smoothstep(0.48, 0.92, ${wave}.z) * smoothstep(0.24, 0.72, waterGrain) * ${shape}.z * ${state}.y * ${wave}.w`),
      // Add a little foam at the moving water/bed contact during run-up.
      `waterFoam += (1.0 - smoothstep(0.015, 0.09, abs(${wave}.x - ${wave}.y))) * max(0.0, ${wave}.z) * ${shape}.z * 0.3 * ${wave}.w * ${state}.y;`,
      variable('waterGeometricNormal', `normalize(cross(${dx}(${world}), ${dy}(${world})))`, 3),
      `waterGeometricNormal *= sign(waterGeometricNormal.y);`,
      // Keep the existing swell/chop bump normal and add the displaced slope.
      `normalW = normalize(normalW + (waterGeometricNormal - ${vec(3)}(0.0, 1.0, 0.0)) * ${wave}.w);`,
    ].join('\n');
    const pbr = this._material instanceof PBRMaterial;
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: varying,
      // Inactive ribbons coincide with the broad surface. Reject them in every
      // pass, including prepass depth, instead of relying on a millimetre lift.
      CUSTOM_FRAGMENT_MAIN_BEGIN: `if (${shore} > 0.5 && ${wave}.z * ${shape}.y * ${state}.y < 0.005) { discard; }`,
      CUSTOM_FRAGMENT_BEFORE_LIGHTS: common + '\n' + (pbr
        ? `surfaceAlbedo = mix(surfaceAlbedo, ${vec(3)}(0.65, 0.72, 0.67), waterFoam);`
        : `diffuseColor = mix(diffuseColor, ${vec(3)}(0.82, 0.86, 0.82), waterFoam);`),
    };
  }
}
