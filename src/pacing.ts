/**
 * Request pacing for {@link BandClient}: a FIFO gate that spaces request *starts*
 * by a random gap and caps how many requests are in flight at once.
 *
 * - Reads wait a gap measured from the previous request's start, so up to
 *   `maxInFlight` of them can overlap — like a browser page firing a few XHRs.
 * - Writes are exclusive: they wait for every in-flight request to finish, then a
 *   gap measured from whichever came last (previous start or completion).
 */
export type Gap = readonly [number, number] | null;

export interface PacerOptions {
  /** Max requests in flight at once (min 1). */
  maxInFlight: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Injectable RNG in `[0, 1)`. Defaults to `Math.random`. */
  random?: () => number;
}

/** Call once the request (including reading its body) has completed. */
export type Release = () => void;

export class Pacer {
  private readonly maxInFlight: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private chain: Promise<unknown> = Promise.resolve();
  private active = 0;
  private lastStartAt = 0;
  private lastEndAt = 0;
  private waiters: Array<() => void> = [];

  constructor(opts: PacerOptions) {
    this.maxInFlight = Math.max(1, Math.floor(opts.maxInFlight));
    this.now = opts.now;
    this.sleep = opts.sleep;
    this.random = opts.random ?? (() => Math.random());
  }

  /** Requests currently holding a slot. */
  get inFlight(): number {
    return this.active;
  }

  /**
   * Wait for this request's turn (FIFO), then for a free slot and its gap. Resolves
   * to a {@link Release} the caller must invoke when the request completes.
   */
  acquire(gap: Gap, opts: { exclusive?: boolean } = {}): Promise<Release> {
    const turn = this.chain.then(() => this.waitTurn(gap, opts.exclusive ?? false));
    this.chain = turn.catch(() => {});
    return turn;
  }

  private async waitTurn(gap: Gap, exclusive: boolean): Promise<Release> {
    const limit = exclusive ? 1 : this.maxInFlight;
    while (this.active >= limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    if (gap && (this.lastStartAt || this.lastEndAt)) {
      const [min, max] = gap;
      const target = min + this.random() * (max - min);
      const since = exclusive ? Math.max(this.lastStartAt, this.lastEndAt) : this.lastStartAt;
      const wait = since + target - this.now();
      if (wait > 0) await this.sleep(wait);
    }
    this.lastStartAt = this.now();
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.lastEndAt = this.now();
      for (const wake of this.waiters.splice(0)) wake();
    };
  }
}

/**
 * Map `items` through `fn` with at most `limit` running at once, preserving order.
 * After the first failure no new items are started; the first error is rethrown
 * once the in-flight ones settle.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  let firstError: unknown;
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i] as T, i);
      } catch (err) {
        if (!failed) firstError = err;
        failed = true;
      }
    }
  };
  const workers = Math.max(1, Math.min(Math.floor(limit), items.length));
  await Promise.all(Array.from({ length: workers }, worker));
  if (failed) throw firstError;
  return results;
}
