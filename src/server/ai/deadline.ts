/**
 * One absolute deadline per assistant turn (ADR 0017 §8), created when the request arrives and
 * passed to every step: history loading, the model, read tools, the mutation journal and
 * telemetry. No new model call and no new mutation starts after it. A mutation that already
 * started is never abandoned mid-flight (the database would finish it anyway): it completes and is
 * recorded in the journal, then the turn ends.
 */

export class DeadlineError extends Error {
  constructor(readonly what: string) {
    super(`deadline exceeded: ${what}`);
    this.name = "DeadlineError";
  }
}

export class Deadline {
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;

  constructor(
    readonly at: number,
    private readonly clock: () => number = Date.now,
  ) {
    this.timer = setTimeout(
      () => {
        this.controller.abort(new DeadlineError("turn"));
      },
      Math.max(0, at - clock()),
    );
  }

  static in(ms: number, clock: () => number = Date.now): Deadline {
    return new Deadline(clock() + ms, clock);
  }

  /** Aborts when the deadline passes (for fetch-based calls such as the model provider). */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  remaining(): number {
    return Math.max(0, this.at - this.clock());
  }

  expired(): boolean {
    return this.clock() >= this.at;
  }

  assertOpen(what: string) {
    if (this.expired()) throw new DeadlineError(what);
  }

  /** Waits for `p` until the deadline (plus `graceMs`); the underlying work is not cancelled. */
  race<T>(p: Promise<T>, what: string, graceMs = 0): Promise<T> {
    const left = this.remaining() + graceMs;
    if (left <= 0) {
      p.catch(() => undefined);
      return Promise.reject(new DeadlineError(what));
    }
    let t: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      t = setTimeout(() => {
        reject(new DeadlineError(what));
      }, left);
    });
    return Promise.race([p, timeout]).finally(() => {
      clearTimeout(t);
    });
  }

  dispose() {
    clearTimeout(this.timer);
  }
}
