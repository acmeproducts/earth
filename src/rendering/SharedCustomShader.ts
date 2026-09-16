import { Effect } from '@babylonjs/core';
import type { CustomMaterial } from '@babylonjs/materials/custom/customMaterial.js';

const shaderNames = new Map<string, string>();

/** CustomMaterial normally generates a new shader name for every material,
 * bypassing the engine's program cache even for identical GLSL. Canonicalize
 * the complete shader/binding signature while retaining independent materials,
 * uniforms, disposal and the engine's normal define-based effect variants.
 */
export function shareCustomShader(material: CustomMaterial): void {
  type Resolver = NonNullable<CustomMaterial['customShaderNameResolve']>;
  const build = material.customShaderNameResolve!;
  const resolved = new Map<string, { vertex: string; fragment: string; name: string }>();
  material.customShaderNameResolve = function (this: CustomMaterial, ...args: Parameters<Resolver>) {
    const generated = build.apply(this, args);
    const vertex = Effect.ShadersStore[`${generated}VertexShader`];
    const fragment = Effect.ShadersStore[`${generated}PixelShader`];
    if (!vertex || !fragment) return generated;
    const bindings = JSON.stringify([generated, args[1], args[2], args[3], args[5]]);
    const previous = resolved.get(bindings);
    if (previous?.vertex === vertex && previous.fragment === fragment &&
        Effect.ShadersStore[`${previous.name}VertexShader`] === vertex &&
        Effect.ShadersStore[`${previous.name}PixelShader`] === fragment) return previous.name;
    const signature = JSON.stringify([vertex, fragment, args[1], args[2], args[3], args[5]]);
    const shared = shaderNames.get(signature);
    if (shared && Effect.ShadersStore[`${shared}VertexShader`] === vertex &&
        Effect.ShadersStore[`${shared}PixelShader`] === fragment) {
      resolved.set(bindings, { vertex, fragment, name: shared });
      return shared;
    }
    shaderNames.set(signature, generated);
    resolved.set(bindings, { vertex, fragment, name: generated });
    return generated;
  };
}
