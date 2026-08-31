/**
 * Public building-renderer API.
 *
 * Geometry compilation lives in BuildingRendererCompiler so callers do not
 * need to know how the renderer is organized internally.
 */
export {
  ProceduralBuildingRenderer,
  stairLayoutFromPlan,
} from "./BuildingRendererCompiler";
export type { BuildingRenderOptions } from "./BuildingRendererCompiler";
