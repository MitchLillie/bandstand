import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  LoginTimeoutError,
  type LoopbackLoginOptions,
  type LoopbackLoginResult,
  bookmarkletSource,
  receiveSessionViaLoopback,
} from "../src/node/login-server";

interface Running {
  result: Promise<LoopbackLoginResult>;
  listening: Promise<{ url: string; port: number; nonce: string }>;
}

const inFlight: Array<{ ac: AbortController; result: Promise<unknown> }> = [];

function start(opts: Omit<LoopbackLoginOptions, "onListening" | "port"> = {}): Running {
  let resolveListening!: (info: { url: string; port: number; nonce: string }) => void;
  const listening = new Promise<{ url: string; port: number; nonce: string }>((r) => {
    resolveListening = r;
  });
  const ac = new AbortController();
  const result = receiveSessionViaLoopback({
    port: 0,
    timeoutMs: 3000,
    signal: ac.signal,
    ...opts,
    onListening: resolveListening,
  });
  inFlight.push({ ac, result: result.catch(() => {}) });
  return { result, listening };
}

async function post(port: number, body: unknown, init: RequestInit = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    ...init,
  });
}

/** Raw GET with an arbitrary Host header (fetch won't let us spoof Host). */
function getWithHost(
  port: number,
  path: string,
  host: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method: "GET", headers: { host } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          body += c;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

afterEach(async () => {
  for (const { ac } of inFlight) ac.abort();
  await Promise.all(inFlight.map((x) => x.result));
  inFlight.length = 0;
});

describe("receiveSessionViaLoopback", () => {
  it("accepts a bookmarklet POST and reports it as untrusted", async () => {
    const { result, listening } = start();
    const { port } = await listening;

    const res = await post(port, {
      band_session: "sess-123",
      secretKey: '"key-abc"',
      via: "bookmarklet",
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });

    const out = await result;
    expect(out).toEqual({
      jar: { band_session: "sess-123", secretKey: '"key-abc"' },
      trusted: false,
      via: "bookmarklet",
    });
  });

  it("marks the session trusted when the nonce matches", async () => {
    const { result, listening } = start();
    const { port, nonce } = await listening;

    await post(port, { band_session: "s", secretKey: "k", nonce, via: "extension" });

    const out = await result;
    expect(out.trusted).toBe(true);
    expect(out.via).toBe("extension");
  });

  it("does not trust a wrong nonce", async () => {
    const { result, listening } = start();
    const { port } = await listening;

    await post(port, { band_session: "s", secretKey: "k", nonce: "deadbeef" });

    expect((await result).trusted).toBe(false);
  });

  it("merges extra cookies without clobbering the core two", async () => {
    const { result, listening } = start();
    const { port } = await listening;

    await post(port, {
      band_session: "s",
      secretKey: "k",
      cookies: { band_session: "SHOULD-NOT-WIN", di: "d1", n: 5 },
    });

    expect((await result).jar).toEqual({ band_session: "s", secretKey: "k", di: "d1" });
  });

  it("rejects a body missing secretKey and keeps waiting", async () => {
    const { result, listening } = start();
    const { port } = await listening;

    const bad = await post(port, { band_session: "s" });
    expect(bad.status).toBe(400);

    // still pending — a good POST afterwards resolves it
    const pending = await Promise.race([
      result.then(() => "resolved"),
      new Promise((r) => setTimeout(() => r("pending"), 100)),
    ]);
    expect(pending).toBe("pending");

    await post(port, { band_session: "s", secretKey: "k" });
    expect((await result).jar.secretKey).toBe("k");
  });

  it("rejects invalid JSON with 400", async () => {
    const { listening } = start();
    const { port } = await listening;
    const res = await fetch(`http://127.0.0.1:${port}/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  it("puts the nonce in the opened URL's fragment, never in the page", async () => {
    const { listening } = start();
    const { url, port, nonce } = await listening;

    expect(url).toBe(`http://127.0.0.1:${port}/#pair=${nonce}`);
    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    expect(html).not.toContain(nonce);
    expect(html).toContain("javascript:");
    expect(html).toContain(`127.0.0.1:${port}`);
  });

  it("points at the Band Tools popup and sends anti-framing / no-store headers", async () => {
    const { listening } = start();
    const { port } = await listening;

    const res = await fetch(`http://127.0.0.1:${port}/`);
    const html = await res.text();
    expect(html).toContain("Send BAND session to bandstand");
    expect(html).toMatch(/bookmarklet/i);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  it("refuses non-loopback Host headers (DNS rebinding)", async () => {
    const { listening } = start();
    const { port } = await listening;

    expect((await getWithHost(port, "/", `attacker.example:${port}`)).status).toBe(421);

    expect((await getWithHost(port, "/status", "attacker.example")).status).toBe(421);
    expect((await getWithHost(port, "/", `127.0.0.1:${port + 1}`)).status).toBe(421);

    const ok = await getWithHost(port, "/", `localhost:${port}`);
    expect(ok.status).toBe(200);
  });

  it("does not accept a session posted under a rebinding Host", async () => {
    const { result, listening } = start();
    const { port, nonce } = await listening;

    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path: "/session",
          method: "POST",
          headers: { host: "attacker.example", "content-type": "application/json" },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify({ band_session: "evil", secretKey: "evil", nonce }));
    });
    expect(status).toBe(421);

    await post(port, { band_session: "s", secretKey: "k", nonce });
    expect((await result).jar.band_session).toBe("s");
  });

  it("flips /status once a session arrives", async () => {
    const { listening } = start();
    const { port } = await listening;

    await expect((await fetch(`http://127.0.0.1:${port}/status`)).json()).resolves.toEqual({
      received: false,
    });

    await post(port, { band_session: "s", secretKey: "k" });

    await expect((await fetch(`http://127.0.0.1:${port}/status`)).json()).resolves.toEqual({
      received: true,
    });
  });

  it("answers CORS preflight for /session", async () => {
    const { listening } = start();
    const { port } = await listening;

    const res = await fetch(`http://127.0.0.1:${port}/session`, {
      method: "OPTIONS",
      headers: { origin: "https://www.band.us" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://www.band.us");
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });

  it("rejects with LoginTimeoutError on abort", async () => {
    const ac = new AbortController();
    const result = receiveSessionViaLoopback({ port: 0, signal: ac.signal });
    ac.abort();
    await expect(result).rejects.toBeInstanceOf(LoginTimeoutError);
  });

  it("rejects with LoginTimeoutError when nothing arrives in time", async () => {
    await expect(receiveSessionViaLoopback({ port: 0, timeoutMs: 50 })).rejects.toBeInstanceOf(
      LoginTimeoutError,
    );
  });

  it("surfaces EADDRINUSE when the port is taken", async () => {
    const { listening } = start();
    const { port } = await listening;

    await expect(receiveSessionViaLoopback({ port, timeoutMs: 500 })).rejects.toThrow(/EADDRINUSE/);
  });
});

describe("bookmarkletSource", () => {
  it("is a javascript: URL that targets the given port and uses the getKey JSONP", () => {
    const src = bookmarkletSource(9999);
    expect(src.startsWith("javascript:")).toBe(true);
    const decoded = decodeURIComponent(src.slice("javascript:".length));
    expect(decoded).toContain('127.0.0.1:"+P+"/session');
    expect(decoded).toContain("var P=9999");
    expect(decoded).toContain("auth.band.us/s/login/getKey");
    expect(decoded).toContain("authCallBack_");
  });

  it("defaults to port 7238", () => {
    expect(decodeURIComponent(bookmarkletSource())).toContain("var P=7238");
  });
});
