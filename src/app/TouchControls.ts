/** Touch buttons hold actions independently of a connected hardware keyboard. */
export class TouchControls {
  readonly element = document.createElement("div");
  readonly held = new Set<string>();
  private readonly pointers = new Map<number, string>();

  constructor(onAction: (code: string) => void) {
    this.element.id = "touchControls";
    for (const [group, entries] of [
      ["touch-movement", [["KeyW", "&#8593;", "Forward"], ["KeyA", "&#8592;", "Left"],
        ["KeyS", "&#8595;", "Backward"], ["KeyD", "&#8594;", "Right"]]],
      ["touch-actions", [["KeyG", "G", "Walk / fly"], ["KeyF", "F", "Interact"],
        ["KeyQ", "&#8722;", "Descend"], ["KeyE", "+", "Ascend"], ["Space", "&#8613;", "Jump"]]],
    ] as const) {
      const section = document.createElement("div");
      section.className = group;
      for (const [code, symbol, label] of entries) {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.code = code;
        button.innerHTML = symbol;
        button.title = label;
        button.setAttribute("aria-label", label);
        button.addEventListener("pointerdown", event => {
          event.preventDefault();
          button.setPointerCapture(event.pointerId);
          this.pointers.set(event.pointerId, code);
          this.held.add(code);
          onAction(code);
        });
        const release = (event: PointerEvent): void => {
          this.pointers.delete(event.pointerId);
          if (![...this.pointers.values()].includes(code)) this.held.delete(code);
        };
        button.addEventListener("pointerup", release);
        button.addEventListener("pointercancel", release);
        button.addEventListener("lostpointercapture", release);
        section.appendChild(button);
      }
      this.element.appendChild(section);
    }
    document.body.appendChild(this.element);
  }

  clear(): void {
    this.pointers.clear();
    this.held.clear();
  }

  dispose(): void {
    this.clear();
    this.element.remove();
  }
}
