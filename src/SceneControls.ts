export const MIN_MODEL_RANGE_METERS = 0;
export const DEFAULT_MODEL_RANGE_METERS = 50;
export const MAX_MODEL_RANGE_METERS = 200;

const MINUTES_PER_HOUR = 60;
const TIME_STEP_HOURS = 0.25;

export class SceneControls {
  private readonly element: HTMLElement;
  private readonly timeInput: HTMLInputElement;
  private readonly timeOutput: HTMLOutputElement;
  private readonly liveButton: HTMLButtonElement;
  private readonly clockTimer: number;
  private isLiveTime = true;

  constructor(
    initialModelRangeMeters: number,
    onModelRangeChange: (distanceMeters: number) => void,
    onTimeOfDayChange: (hours: number | undefined) => void,
  ) {
    this.element = document.createElement("section");
    this.element.id = "sceneControls";
    this.element.setAttribute("aria-label", "Scene controls");
    this.element.appendChild(this.createModelRangeControl(initialModelRangeMeters, onModelRangeChange));

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
      onTimeOfDayChange(undefined);
    });

    this.timeInput.addEventListener("input", () => {
      this.isLiveTime = false;
      const hours = Number(this.timeInput.value);
      this.updateTimeDisplay(hours);
      onTimeOfDayChange(hours);
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

  private createModelRangeControl(
    initialDistanceMeters: number,
    onChange: (distanceMeters: number) => void,
  ): HTMLLabelElement {
    const row = document.createElement("label");
    row.className = "scene-control-row";
    const label = document.createElement("span");
    label.textContent = "Model range";

    const input = document.createElement("input");
    input.type = "range";
    input.min = String(MIN_MODEL_RANGE_METERS);
    input.max = String(MAX_MODEL_RANGE_METERS);
    input.step = "1";
    input.value = String(initialDistanceMeters);
    input.setAttribute("aria-label", "Real model range in meters");

    const output = document.createElement("output");
    output.value = `${initialDistanceMeters} m`;
    input.addEventListener("input", () => {
      const distance = Number(input.value);
      output.value = `${distance} m`;
      onChange(distance);
    });

    row.append(label, input, output);
    return row;
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
