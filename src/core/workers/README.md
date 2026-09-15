# Worker Tasks

`WorkerTaskClient<Input, Output>` owns one lazy dedicated worker. `run(input)`
returns a promise, with at most one request posted at a time. The caller-side
FIFO queue holds up to 32 pending jobs including the active job. Jobs time out
after 60 seconds once dispatched; both limits are constructor arguments.

To add a task:

1. Define structured-cloneable input and output types beside the domain code.
2. Bind the operation with `exposeWorkerTask(scope, operation)` in a worker entry.
3. Supply a worker factory using Webpack's literal
   `new Worker(new URL("./Task.worker.ts", import.meta.url), { type: "module" })`
   pattern. See `RoadPlanningWorker` for a complete example.

Send plain geometry, not scene objects, callbacks, caches, or class instances.
Inputs are cloned when dispatched; do not mutate queued inputs. Buffers are not
transferred, so caller-owned data remains usable. A pool or transfer-list API
can be added when a measured workload warrants it.

Task exceptions reject that task and allow the queue to continue. Startup,
serialization, crash, and timeout failures reject all pending tasks and terminate
the worker. There is no implicit main-thread fallback. A later request can start
a fresh worker.

`reset()` interrupts active computation and rejects queued jobs with `AbortError`.
Use it when the owning world changes, and check the world generation again after
awaiting a result. `dispose()` also permanently rejects future submissions.

Transport is independent of diagnostics. Domain adapters can return timings;
`recordWorkerStages` aligns worker timestamps to the page and marks them as worker
execution. Slow summaries use `worker.stage.*`, distinct from blocking
`streaming.stage.*` work. Worker wait stages remain wall-clock measurements.

Verification: run `tests/worker-task.test.mjs` with the repository TypeScript
loader. After a development Webpack build, set `CHROME_BIN` and run
`tests/worker-browser.test.mjs` to test the emitted worker in headless Chrome.
