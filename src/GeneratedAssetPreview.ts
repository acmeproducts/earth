/** A view into an atlas already produced by world generation. */
export interface GeneratedAssetPreview {
  name: string;
  canvas: HTMLCanvasElement;
  x: number;
  y: number;
  width: number;
  height: number;
}

const observers = new Set<(asset: GeneratedAssetPreview) => void>();

export function observeGeneratedAsset(observer: (asset: GeneratedAssetPreview) => void): () => void {
  observers.add(observer);
  return () => { observers.delete(observer); };
}

/** Synchronous consumption: observers need not retain atlas or GPU resources. */
export function publishGeneratedAsset(asset: GeneratedAssetPreview): void {
  for (const observer of observers) {
    try {
      observer(asset);
    } catch (error) {
      // A cosmetic preview must never interrupt world generation.
      console.warn('Generated asset preview unavailable:', error);
    }
  }
}
