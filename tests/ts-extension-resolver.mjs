/**
 * Resolves the sources' extensionless relative imports (webpack-style) when
 * tests import .ts modules directly under node's type stripping.
 */
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (specifier.startsWith("./") || specifier.startsWith("../")) {
      return nextResolve(`${specifier}.ts`, context);
    }
    throw error;
  }
}
