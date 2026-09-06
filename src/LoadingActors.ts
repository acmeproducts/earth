import { observeGeneratedAsset } from './GeneratedAssetPreview';

/** Displays existing world captures without creating models or a WebGL context. */
export class LoadingActors {
  private readonly unsubscribe: () => void;

  constructor(canvas: HTMLCanvasElement, caption: HTMLElement) {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Loading preview requires a 2D canvas.');
    this.unsubscribe = observeGeneratedAsset((asset) => {
      const scale = Math.min(canvas.width / asset.width, canvas.height / asset.height) * 0.85;
      const width = asset.width * scale;
      const height = asset.height * scale;
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(
        asset.canvas, asset.x, asset.y, asset.width, asset.height,
        (canvas.width - width) / 2, (canvas.height - height) / 2, width, height,
      );
      const name = asset.name.replace(/Impostor$/, '').replace(/([a-z])([A-Z])/g, '$1 $2');
      caption.textContent = name.charAt(0).toUpperCase() + name.slice(1);
      canvas.setAttribute('aria-label', `Generated asset: ${caption.textContent}`);
    });
  }

  dispose(): void {
    this.unsubscribe();
  }
}
