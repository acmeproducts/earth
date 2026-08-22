import { SCENE_SETTING_DEFINITIONS } from "./SceneSettings";
import type {
  SceneSettingDefinition,
  SceneSettingKey,
  SceneSettings,
} from "./SceneSettings";

export interface SceneControlsOptions {
  settings: Readonly<SceneSettings>;
  onSettingChange: (key: SceneSettingKey, value: number) => void;
  onTimeOfDayChange: (hours: number | undefined) => void;
}

const MINUTES_PER_HOUR = 60;
const TIME_STEP_HOURS = 0.25;

export class SceneControls {
  private readonly element: HTMLElement;
  private readonly timeInput: HTMLInputElement;
  private readonly timeOutput: HTMLOutputElement;
  private readonly liveButton: HTMLButtonElement;
  private readonly clockTimer: number;
  private readonly rangeControls = new Map<SceneSettingKey, RangeControl>();
  private isLiveTime = true;

  constructor(options: SceneControlsOptions) {
    this.element = document.createElement("section");
    this.element.id = "sceneControls";
    this.element.setAttribute("aria-label", "Scene controls");
    for (const definition of SCENE_SETTING_DEFINITIONS) {
      const control = this.createRangeControl(
        definition,
        options.settings[definition.key],
        (value) => options.onSettingChange(definition.key, value),
      );
      this.rangeControls.set(definition.key, control);
      this.element.appendChild(control.row);
    }

    const timeRow = document.createElement("label");
    timeRow.className = "scene-control-row";
    const timeLabel = document.createElement("span");
    timeLabel.textContent = "Time of day";

    this.timeInput = document.createElement("input");
    this.timeInput.type = "range";
    this.timeInput.min = "0";
    this.timeInput.max = String(24 - TIME_STEP_HOURS);
    this.timeInput.step = String(TIME_STEP_HOURS);
    this.timeInput.setAttribute("aria-label", "Time of day");
    this.timeOutput = document.createElement("output");

    this.liveButton = document.createElement("button");
    this.liveButton.type = "button";
    this.liveButton.textContent = "Live";
    this.liveButton.title = "Use the current time";
    this.liveButton.addEventListener("click", () => {
      this.isLiveTime = true;
      this.updateLiveTime();
      options.onTimeOfDayChange(undefined);
    });

    this.timeInput.addEventListener("input", () => {
      this.isLiveTime = false;
      const hours = Number(this.timeInput.value);
      this.updateTimeDisplay(hours);
      options.onTimeOfDayChange(hours);
    });

    timeRow.append(timeLabel, this.timeInput, this.timeOutput, this.liveButton);
    this.element.appendChild(timeRow);
    document.body.appendChild(this.element);
    this.updateLiveTime();
    this.clockTimer = window.setInterval(() => this.updateLiveTime(), 60_000);
  }

  dispose(): void {
    window.clearInterval(this.clockTimer);
    this.element.remove();
  }

  setSettings(settings: Readonly<SceneSettings>): void {
    for (const definition of SCENE_SETTING_DEFINITIONS) {
      this.rangeControls.get(definition.key)?.setValue(settings[definition.key]);
    }
  }

  private createRangeControl(
    definition: SceneSettingDefinition,
    initialValue: number,
    onChange: (value: number) => void,
  ): RangeControl {
    const row = document.createElement("label");
    row.className = "scene-control-row";
    const label = document.createElement("span");
    label.textContent = definition.label;

    const input = document.createElement("input");
    input.type = "range";
    input.min = String(definition.minimum);
    input.max = String(definition.maximum);
    input.step = String(definition.step);
    input.value = String(initialValue);
    input.setAttribute("aria-label", definition.ariaLabel);

    const output = document.createElement("output");
    const setValue = (value: number): void => {
      input.value = String(value);
      output.value = definition.format(value);
    };
    setValue(initialValue);
    input.addEventListener("input", () => {
      const value = Number(input.value);
      output.value = definition.format(value);
      onChange(value);
    });

    row.append(label, input, output);
    return { row, input, setValue };
  }

  private updateLiveTime(): void {
    if (!this.isLiveTime) return;
    const now = new Date();
    const hours = now.getHours() + now.getMinutes() / MINUTES_PER_HOUR;
    this.timeInput.value = String(hours);
    this.updateTimeDisplay(hours);
  }

  private updateTimeDisplay(hours: number): void {
    const totalMinutes = Math.round(hours * MINUTES_PER_HOUR);
    const displayHours = Math.floor(totalMinutes / MINUTES_PER_HOUR) % 24;
    const displayMinutes = totalMinutes % MINUTES_PER_HOUR;
    this.timeOutput.value = `${String(displayHours).padStart(2, "0")}:${String(displayMinutes).padStart(2, "0")}`;
    this.liveButton.classList.toggle("active", this.isLiveTime);
    this.liveButton.setAttribute("aria-pressed", String(this.isLiveTime));
  }
}

interface RangeControl {
  row: HTMLLabelElement;
  input: HTMLInputElement;
  setValue: (value: number) => void;
}
