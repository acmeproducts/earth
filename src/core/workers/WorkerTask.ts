export interface WorkerRequest<Input> {
  id: number;
  input: Input;
}

export type WorkerResponse<Output> =
  | { id: number; ok: true; output: Output }
  | { id: number; ok: false; error: { name: string; message: string; stack?: string } };

export interface WorkerTaskScope<Input, Output> {
  onmessage: ((event: MessageEvent<WorkerRequest<Input>>) => void) | null;
  postMessage(message: WorkerResponse<Output>): void;
}

/** Bind a pure task to a dedicated worker without domain-specific transport code. */
export function exposeWorkerTask<Input, Output>(
  scope: WorkerTaskScope<Input, Output>,
  operation: (input: Input) => Output | Promise<Output>,
): void {
  scope.onmessage = async ({ data: { id, input } }) => {
    try {
      scope.postMessage({ id, ok: true, output: await operation(input) });
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      scope.postMessage({ id, ok: false, error: {
        name: error.name, message: error.message, stack: error.stack,
      } });
    }
  };
}
