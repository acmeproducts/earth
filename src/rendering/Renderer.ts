import {
  AbstractEngine,
  Engine,
  WebGPUEngine,
} from "@babylonjs/core";
import { guardUnusedRenderPassCleanup } from "./RenderPassCleanup";
import { enableWebGLHalfRangeDepth } from "./WebGLDepth";

export type RendererBackend = "webgl" | "webgpu";

export interface RenderingEngineOptions {
  antialias: boolean;
  stencil: boolean;
  preserveDrawingBuffer?: boolean;
}

export interface RenderingEngine {
  canvas: HTMLCanvasElement;
  engine: AbstractEngine;
}

export function requestedRenderer(query: URLSearchParams): RendererBackend {
  return query.get("renderer")?.toLowerCase() === "webgpu" ? "webgpu" : "webgl";
}

export async function createRenderingEngine(
  canvas: HTMLCanvasElement,
  requestedBackend: RendererBackend,
  options: RenderingEngineOptions,
): Promise<RenderingEngine> {
  guardUnusedRenderPassCleanup();
  if (requestedBackend === "webgpu") {
    let webgpu: WebGPUEngine | undefined;
    try {
      if (!await WebGPUEngine.IsSupportedAsync) {
        throw new Error("WebGPU is unavailable in this browser or GPU configuration.");
      }
      webgpu = new WebGPUEngine(canvas, {
        antialias: options.antialias,
        stencil: options.stencil,
        powerPreference: "high-performance",
      });
      await webgpu.initAsync();
      console.info("[Renderer] Using WebGPU.", webgpu.getInfo());
      return { canvas, engine: webgpu };
    } catch (error) {
      webgpu?.dispose();
      console.warn("[Renderer] WebGPU initialization failed; falling back to WebGL.", error);
      if (webgpu) {
        const replacement = canvas.cloneNode(true) as HTMLCanvasElement;
        canvas.replaceWith(replacement);
        canvas = replacement;
      }
    }
  }

  const webgl = new Engine(canvas, options.antialias, {
    preserveDrawingBuffer: options.preserveDrawingBuffer ?? false,
    stencil: options.stencil,
    antialias: options.antialias,
  });
  enableWebGLHalfRangeDepth(webgl);
  console.info("[Renderer] Using WebGL.", webgl.getInfo());
  return { canvas, engine: webgl };
}
