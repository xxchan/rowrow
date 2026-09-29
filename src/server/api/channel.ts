// A push-to-pull bridge for streaming procedures: producers push values as things happen,
// the oRPC handler iterates them. When the client goes away, the iterator's return() runs
// the cleanup (unsubscribe) exactly once.

export interface Channel<T> {
  push(value: T): void;
  /** End the stream after what's buffered. */
  close(): void;
  /** End the stream with an error (the client sees it). */
  fail(error: Error): void;
  readonly iterator: AsyncGenerator<T, void, unknown>;
}

export function channel<T>(onClose: () => void, signal?: AbortSignal): Channel<T> {
  const buffer: T[] = [];
  let waiting: ((result: IteratorResult<T, void>) => void) | null = null;
  let rejectWaiting: ((error: Error) => void) | null = null;
  let done = false;
  let failure: Error | null = null;
  let cleaned = false;

  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    onClose();
  };

  const wake = (): void => {
    if (waiting === null) return;
    const resolve = waiting;
    const reject = rejectWaiting;
    waiting = null;
    rejectWaiting = null;
    if (buffer.length > 0) resolve({ value: buffer.shift() as T, done: false });
    else if (failure !== null) reject?.(failure);
    else if (done) resolve({ value: undefined, done: true });
  };

  signal?.addEventListener("abort", () => {
    done = true;
    cleanup();
    wake();
  });

  async function* iterate(): AsyncGenerator<T, void, unknown> {
    try {
      while (true) {
        if (buffer.length > 0) {
          yield buffer.shift() as T;
          continue;
        }
        if (failure !== null) throw failure;
        if (done) return;
        const next = await new Promise<IteratorResult<T, void>>((resolve, reject) => {
          waiting = resolve;
          rejectWaiting = reject;
        });
        if (next.done === true) return;
        yield next.value;
      }
    } finally {
      cleanup();
    }
  }

  return {
    push(value) {
      if (done) return;
      buffer.push(value);
      wake();
    },
    close() {
      done = true;
      wake();
    },
    fail(error) {
      failure = error;
      wake();
    },
    iterator: iterate(),
  };
}
