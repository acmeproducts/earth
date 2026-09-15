import type { WorkerResponse } from "./WorkerTask";

type TaskWorker = Pick<Worker, "postMessage" | "terminate" | "onmessage" | "onerror" | "onmessageerror">;

interface PendingTask<Input, Output> {
  id: number;
  input: Input;
  resolve: (output: Output) => void;
  reject: (error: Error) => void;
}

/** One lazy worker, with a bounded FIFO queue kept on the caller's thread. */
export class WorkerTaskClient<Input, Output> {
  private worker?: TaskWorker;
  private readonly queue: PendingTask<Input, Output>[] = [];
  private current?: PendingTask<Input, Output>;
  private timer?: ReturnType<typeof setTimeout>;
  private nextId = 0;
  private disposed = false;
  private readonly createWorker: () => TaskWorker;
  private readonly maxPending: number;
  private readonly timeoutMilliseconds: number;

  constructor(createWorker: () => TaskWorker, maxPending = 32, timeoutMilliseconds = 60_000) {
    this.createWorker = createWorker;
    this.maxPending = maxPending;
    this.timeoutMilliseconds = timeoutMilliseconds;
  }

  run(input: Input): Promise<Output> {
    if (this.disposed) return Promise.reject(new Error("Worker task client is disposed"));
    if (this.queue.length + Number(!!this.current) >= this.maxPending) {
      return Promise.reject(new Error("Worker task queue is full"));
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ id: ++this.nextId, input, resolve, reject });
      this.dispatch();
    });
  }

  /** Termination also interrupts synchronous work; the next task gets a fresh worker. */
  reset(error: Error = new DOMException("Worker tasks cancelled", "AbortError")): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    const worker = this.worker;
    this.worker = undefined;
    if (worker) {
      worker.onmessage = worker.onerror = worker.onmessageerror = null;
      worker.terminate();
    }
    const tasks = this.current ? [this.current, ...this.queue] : [...this.queue];
    this.current = undefined;
    this.queue.length = 0;
    for (const task of tasks) task.reject(error);
  }

  dispose(): void {
    this.disposed = true;
    this.reset();
  }

  private dispatch(): void {
    if (this.current || !this.queue.length) return;
    this.current = this.queue.shift()!;
    try {
      if (!this.worker) {
        const worker = this.createWorker();
        this.worker = worker;
        worker.onmessage = (event: MessageEvent<WorkerResponse<Output>>) => {
          if (this.worker !== worker) return;
          const response = event.data;
          const task = this.current;
          if (!task || response.id !== task.id) return;
          clearTimeout(this.timer);
          this.timer = undefined;
          this.current = undefined;
          if (response.ok) task.resolve(response.output);
          else {
            const error = new Error(response.error.message);
            error.name = response.error.name;
            error.stack = response.error.stack;
            task.reject(error);
          }
          this.dispatch();
        };
        worker.onerror = (event) => {
          event.preventDefault();
          if (this.worker === worker) this.reset(new Error(event.message || "Worker failed to load or crashed"));
        };
        worker.onmessageerror = () => {
          if (this.worker === worker) this.reset(new Error("Worker response could not be deserialized"));
        };
      }
      this.timer = setTimeout(() => this.reset(new Error("Worker task timed out")), this.timeoutMilliseconds);
      this.worker.postMessage({ id: this.current.id, input: this.current.input });
    } catch (cause) {
      this.reset(cause instanceof Error ? cause : new Error(String(cause)));
    }
  }
}
