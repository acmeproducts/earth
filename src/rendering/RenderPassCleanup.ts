import { SubMesh } from "@babylonjs/core";

let installed = false;

/** Babylon 7 grows every submesh's sparse cache when an unused pass is released. */
export function guardUnusedRenderPassCleanup(): void {
  if (installed) return;
  installed = true;
  const remove = SubMesh.prototype._removeDrawWrapper;
  SubMesh.prototype._removeDrawWrapper = function (passId, disposeWrapper = true, immediate = false) {
    // Temporary impostor captures use monotonically increasing IDs. Assigning
    // undefined at those IDs otherwise grows thousands of unrelated arrays.
    if (this._getDrawWrapper(passId)) remove.call(this, passId, disposeWrapper, immediate);
  };
}
