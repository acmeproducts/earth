import { VegetationRenderMode } from "./VegetationField";

export type VegetationCategory = "trees" | "grass" | "bushes";
export type VegetationModes = Record<VegetationCategory, VegetationRenderMode>;

export const MIN_MODEL_RANGE_METERS = 0;
export const DEFAULT_MODEL_RANGE_METERS = 50;
export const MAX_MODEL_RANGE_METERS = 200;

const CATEGORIES: ReadonlyArray<readonly [VegetationCategory, string]> = [
  ["trees", "Trees"],
  ["grass", "Grass"],
  ["bushes", "Bushes"],
];

export class VegetationControls {
  private readonly element: HTMLElement;
  private readonly buttons = new Map<string, HTMLButtonElement>();
  private readonly ambientOcclusionInput: HTMLInputElement;

  constructor(
    initialModes: VegetationModes,
    initialDistanceMeters: number,
    initialAmbientOcclusionEnabled: boolean,
    onChange: (category: VegetationCategory, mode: VegetationRenderMode) => void,
    onDistanceChange: (distanceMeters: number) => void,
    onAmbientOcclusionChange: (enabled: boolean) => void,
  ) {
    this.element = document.createElement("section");
    this.element.id = "vegetationControls";
    this.element.setAttribute("aria-label", "Vegetation renderer");

    const heading = document.createElement("h2");
    heading.textContent = "Vegetation renderer";
    this.element.appendChild(heading);

    for (const [category, label] of CATEGORIES) {
      const row = document.createElement("div");
      row.className = "vegetation-control-row";

      const rowLabel = document.createElement("span");
      rowLabel.textContent = label;
      row.appendChild(rowLabel);

      const group = document.createElement("div");
      group.className = "vegetation-segmented";
      group.setAttribute("role", "group");
      group.setAttribute("aria-label", `${label} renderer`);

      const renderModes: ReadonlyArray<readonly [VegetationRenderMode, string]> = category === "grass" || category === "bushes"
        ? [
          ["impostors", "Impostor"],
          ["auto", "Auto"],
        ]
        : [
          ["impostors", "Impostor"],
          ["auto", "Auto"],
          ["models", "Model"],
        ];
      for (const [mode, modeLabel] of renderModes) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = modeLabel;
        button.addEventListener("click", () => onChange(category, mode));
        this.buttons.set(this.key(category, mode), button);
        group.appendChild(button);
      }

      row.appendChild(group);
      this.element.appendChild(row);
    }

    const ambientOcclusionRow = document.createElement("label");
    ambientOcclusionRow.className = "vegetation-ao-row";

    const ambientOcclusionLabel = document.createElement("span");
    ambientOcclusionLabel.textContent = "Ambient occlusion";

    this.ambientOcclusionInput = document.createElement("input");
    this.ambientOcclusionInput.type = "checkbox";
    this.ambientOcclusionInput.checked = initialAmbientOcclusionEnabled;
    this.ambientOcclusionInput.addEventListener("change", () => {
      onAmbientOcclusionChange(this.ambientOcclusionInput.checked);
    });

    ambientOcclusionRow.append(ambientOcclusionLabel, this.ambientOcclusionInput);
    this.element.appendChild(ambientOcclusionRow);

    const distanceRow = document.createElement("label");
    distanceRow.className = "vegetation-distance-row";
    distanceRow.textContent = "Model range";

    const distanceInput = document.createElement("input");
    distanceInput.type = "range";
    distanceInput.min = String(MIN_MODEL_RANGE_METERS);
    distanceInput.max = String(MAX_MODEL_RANGE_METERS);
    distanceInput.step = "1";
    distanceInput.value = String(initialDistanceMeters);
    distanceInput.setAttribute("aria-label", "Real model range in meters");

    const distanceOutput = document.createElement("output");
    distanceOutput.value = `${initialDistanceMeters} m`;
    distanceInput.addEventListener("input", () => {
      const distance = Number(distanceInput.value);
      distanceOutput.value = `${distance} m`;
      onDistanceChange(distance);
    });

    distanceRow.append(distanceInput, distanceOutput);
    this.element.appendChild(distanceRow);

    document.body.appendChild(this.element);
    this.setModes(initialModes);
  }

  setModes(modes: VegetationModes): void {
    for (const [category] of CATEGORIES) this.setMode(category, modes[category]);
  }

  setMode(category: VegetationCategory, mode: VegetationRenderMode): void {
    for (const candidate of ["impostors", "auto", "models"] as const) {
      const active = candidate === mode;
      const button = this.buttons.get(this.key(category, candidate));
      button?.classList.toggle("active", active);
      button?.setAttribute("aria-pressed", String(active));
    }
  }

  setAmbientOcclusionEnabled(enabled: boolean): void {
    this.ambientOcclusionInput.checked = enabled;
  }

  dispose(): void {
    this.element.remove();
  }

  private key(category: VegetationCategory, mode: VegetationRenderMode): string {
    return `${category}:${mode}`;
  }
}
