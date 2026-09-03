import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Resolves the sources' extensionless relative imports (webpack-style) when
 * tests import .ts modules directly under node's type stripping.
 */
export function resolve(specifier, context, nextResolve) {
  if (context.parentURL && (specifier.startsWith("./") || specifier.startsWith("../"))) {
    const source = fileURLToPath(new URL(specifier, context.parentURL)) + ".ts";
    if (existsSync(source)) return { url: pathToFileURL(source).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
