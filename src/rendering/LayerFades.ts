import type { VegetationFieldResult } from "../vegetation/VegetationField";

const LAYER_FADE_DURATION_MS = 700;

interface LayerFade {
  startMilliseconds: number;
  from: number;
  to: number;
  apply: (fade: number) => void;
  onComplete?: () => void;
  refreshShadows: boolean;
}

interface LayerFadesOptions {
  refreshShadows: () => void;
  refreshShadowsDuringFade: () => void;
}

/** Advances streamed-layer cross-fades and owns their temporary shadow refreshes. */
export class LayerFades {
  private readonly active: LayerFade[] = [];

  constructor(private readonly options: LayerFadesOptions) {}

  get size(): number {
    return this.active.length;
  }

  begin(
    from: number,
    to: number,
    apply: (fade: number) => void,
    onComplete?: () => void,
    refreshShadows = false,
  ): void {
    apply(from);
    this.active.push({
      startMilliseconds: performance.now(),
      from,
      to,
      apply,
      onComplete,
      refreshShadows,
    });
  }

  fadeFieldIn(field: VegetationFieldResult, refreshShadows = false): void {
    this.begin(0, 1, (fade) => {
      if (!field.root.isDisposed()) field.setFade(fade);
    }, () => {
      // Leave one settled static frame after the temporary fade refreshes.
      this.options.refreshShadows();
    }, refreshShadows);
  }

  fadeFieldOutAndDispose(field: VegetationFieldResult, refreshShadows = false): void {
    this.begin(1, 0, (fade) => {
      if (!field.root.isDisposed()) field.setFade(fade);
    }, () => field.root.dispose(false, false), refreshShadows);
  }

  update(): void {
    if (this.active.length === 0) return;
    const now = performance.now();
    let refreshShadows = false;
    for (let index = this.active.length - 1; index >= 0; index--) {
      const fade = this.active[index];
      refreshShadows = refreshShadows || fade.refreshShadows;
      const progress = Math.min(1, (now - fade.startMilliseconds) / LAYER_FADE_DURATION_MS);
      const eased = progress * progress * (3 - 2 * progress);
      fade.apply(fade.from + (fade.to - fade.from) * eased);
      if (progress >= 1) {
        this.active.splice(index, 1);
        fade.onComplete?.();
      }
    }
    if (refreshShadows) this.options.refreshShadowsDuringFade();
  }

  /** Settle generated layers before revealing the initial world. */
  finish(): void {
    const fades = this.active.splice(0);
    for (const fade of fades) {
      fade.apply(fade.to);
      fade.onComplete?.();
    }
    if (fades.some((fade) => fade.refreshShadows)) this.options.refreshShadows();
  }

  clear(): void {
    this.active.length = 0;
  }
}
