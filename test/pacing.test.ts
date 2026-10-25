import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BandClient } from "../src/client";
import { Pacer, mapLimit } from "../src/pacing";

const tick = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A pacer on the fake clock whose random gap always lands mid-range. */
function pacer(maxInFlight: number): Pacer {
  return new Pacer({ maxInFlight, now: Date.now, sleep: tick, random: () => 0.5 });
}

describe("Pacer", () => {
  it("spaces read starts by the gap and caps concurrency", async () => {
    const p = pacer(3);
    const starts: number[] = [];
    let peak = 0;
    const read = async () => {
      const release = await p.acquire([100, 300]);
      starts.push(Date.now() - 1_000_000);
      peak = Math.max(peak, p.inFlight);
      await tick(1000); // a slow request
      release();
    };
    const all = Promise.all([read(), read(), read(), read()]);
    await vi.advanceTimersByTimeAsync(5000);
    await all;
    // gap = 100 + 0.5 * 200 = 200ms between starts; the 4th waits for a free slot.
    expect(starts).toEqual([0, 200, 400, 1000]);
    expect(peak).toBe(3);
  });

  it("does not delay the very first call", async () => {
    const p = pacer(1);
    const release = await p.acquire([300, 900]);
    expect(Date.now()).toBe(1_000_000);
    release();
  });

  it("runs a write alone, gapped from the last completion", async () => {
    const p = pacer(3);
    const events: string[] = [];
    const readDone = (async () => {
      const release = await p.acquire([100, 300]);
      events.push(`read@${Date.now() - 1_000_000}`);
      await tick(500);
      release();
    })();
    const writeDone = (async () => {
      const release = await p.acquire([300, 900], { exclusive: true });
      events.push(`write@${Date.now() - 1_000_000}`);
      expect(p.inFlight).toBe(1);
      release();
    })();
    await vi.advanceTimersByTimeAsync(5000);
    await Promise.all([readDone, writeDone]);
    // read finishes at 500; write gap = 300 + 0.5 * 600 = 600 → starts at 1100.
    expect(events).toEqual(["read@0", "write@1100"]);
  });

  it("keeps FIFO order: a read queued after a write waits for it", async () => {
    const p = pacer(3);
    const order: string[] = [];
    const run = async (name: string, exclusive: boolean, hold: number) => {
      const release = await p.acquire([100, 100], { exclusive });
      order.push(name);
      await tick(hold);
      release();
    };
    const all = Promise.all([run("r1", false, 300), run("w", true, 300), run("r2", false, 10)]);
    await vi.advanceTimersByTimeAsync(5000);
    await all;
    expect(order).toEqual(["r1", "w", "r2"]);
  });

  it("with a null gap only the concurrency cap applies", async () => {
    const p = pacer(2);
    const starts: number[] = [];
    const run = async () => {
      const release = await p.acquire(null);
      starts.push(Date.now() - 1_000_000);
      await tick(100);
      release();
    };
    const all = Promise.all([run(), run(), run()]);
    await vi.advanceTimersByTimeAsync(1000);
    await all;
    expect(starts).toEqual([0, 0, 100]);
  });

  it("release is idempotent", async () => {
    const p = pacer(1);
    const release = await p.acquire(null);
    release();
    release();
    expect(p.inFlight).toBe(0);
  });
});

describe("mapLimit", () => {
  it("preserves order and never exceeds the limit", async () => {
    let active = 0;
    let peak = 0;
    const done = mapLimit([30, 10, 20, 5, 15], 2, async (ms, i) => {
      active++;
      peak = Math.max(peak, active);
      await tick(ms);
      active--;
      return i * 10;
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await done).toEqual([0, 10, 20, 30, 40]);
    expect(peak).toBe(2);
  });

  it("stops starting new items after the first failure and rethrows it", async () => {
    const started: number[] = [];
    const done = mapLimit([0, 1, 2, 3, 4, 5], 2, async (n) => {
      started.push(n);
      await tick(n === 0 ? 50 : 10); // item 1 fails while item 0 is still running
      if (n === 1) throw new Error("boom");
      return n;
    });
    const settled = done.catch((err: Error) => err.message);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await settled).toBe("boom");
    expect(started).toEqual([0, 1]);
  });

  it("handles an empty list", async () => {
    expect(await mapLimit([], 3, async () => 1)).toEqual([]);
  });
});

// Real timers here: request signing awaits Web Crypto, which resolves outside the
// fake-timer queue, so gaps are kept small and asserted with tolerance. Times are
// taken at fetch, after signing, so a gap can measure short by the signing jitter.
describe("BandClient pacing", () => {
  const COOKIES = { band_session: "sess", secretKey: '"key"' };
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const SLACK = 25;

  beforeEach(() => {
    vi.useRealTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
  });

  it("overlaps reads up to maxInFlight with spaced starts; writes wait for them", async () => {
    const log: Array<{ path: string; at: number }> = [];
    const t0 = Date.now();
    const fetchImpl = (async (url: string | URL) => {
      log.push({ path: new URL(String(url)).pathname, at: Date.now() - t0 });
      await sleep(100);
      return jsonResponse({ result_code: 1, result_data: { schedule: {} } });
    }) as typeof fetch;
    const client = await BandClient.create({
      cookies: COOKIES,
      fetch: fetchImpl,
      readJitterMs: [40, 40],
      jitterMs: [60, 60],
      maxInFlight: 2,
      warmUp: false,
    });

    await Promise.all([
      client.getSchedule(1, "a"),
      client.getSchedule(1, "b"),
      client.getSchedule(1, "c"),
      client.createSchedule(1, { name: "x" }),
    ]);

    const [a, b, c, w] = log.map((l) => l.at) as [number, number, number, number];
    expect(b - a).toBeGreaterThanOrEqual(40 - SLACK); // starts spaced by the read gap…
    expect(b - a).toBeLessThan(100); // …but overlapping (a still in flight)
    expect(c - a).toBeGreaterThanOrEqual(100 - SLACK); // 3rd read waits for a free slot
    expect(w - c).toBeGreaterThanOrEqual(100 + 60 - SLACK); // write: after c completes + gap
    expect(w - c).toBeLessThan(100 + 60 + SLACK * 2);
    expect(log[3]?.path).toBe("/v2.0.0/create_schedule");
  });

  it("an explicit jitterMs also slows reads unless readJitterMs is given", async () => {
    const at: number[] = [];
    const fetchImpl = (async () => {
      at.push(Date.now());
      return jsonResponse({ result_code: 1, result_data: {} });
    }) as typeof fetch;
    const client = await BandClient.create({
      cookies: COOKIES,
      fetch: fetchImpl,
      jitterMs: [80, 80],
    });
    await Promise.all([client.getCalendars(1), client.getCalendars(1)]);
    expect((at[1] ?? 0) - (at[0] ?? 0)).toBeGreaterThanOrEqual(80 - SLACK);
  });
});
