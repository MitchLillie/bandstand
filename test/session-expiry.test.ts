import { describe, expect, it } from "vitest";
import { BandClient } from "../src/client";
import { SESSION_EXPIRED_HINT } from "../src/constants";
import { AuthError, SessionExpiredError, authFailureMessage } from "../src/errors";
import { MemoryCookieStore } from "../src/store";

const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;
const EXPIRED_MESSAGE =
  "Your previous session is expired as 4 hours passed after sign in. Please log in again for the safe use of PC version.";

/** An unsigned JWT-shaped `band_session` with the given `exp` (ms). */
function fakeJwt(expMs: number, jti = "j1"): string {
  const b64url = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${b64url({ alg: "RS256" })}.${b64url({ jti, exp: Math.floor(expMs / 1000) })}.sig`;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** A fetch that serves scripted API responses in order, recording each URL. */
function scriptedFetch(api: Array<() => Response>) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL) => {
    calls.push(String(url));
    const next = api[calls.length - 1];
    if (!next) throw new Error(`unexpected API call ${String(url)}`);
    return next();
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const OK = () => jsonResponse({ result_code: 1, result_data: { internal_calendars: [] } });
const EXPIRED = () => jsonResponse({ result_code: 300, result_data: { message: EXPIRED_MESSAGE } });

async function makeClient(bandSession: string, fetchImpl: typeof fetch) {
  return BandClient.create({
    // "a2V5" is base64url for "key" — JWT sessions base64url-decode the secret.
    cookies: { band_session: bandSession, secretKey: '"a2V5"' },
    store: new MemoryCookieStore(),
    fetch: fetchImpl,
    jitterMs: null,
    readJitterMs: null,
    now: () => NOW,
  });
}

describe("session expiry", () => {
  it("reports when the session expires, from the JWT exp", async () => {
    const client = await makeClient(fakeJwt(NOW + 2 * HOUR), scriptedFetch([]).fetchImpl);
    expect(client.sessionExpiresAt()).toBe(NOW + 2 * HOUR);
  });

  it("calls through while the session is live", async () => {
    const s = scriptedFetch([OK]);
    const client = await makeClient(fakeJwt(NOW + 2 * HOUR), s.fetchImpl);
    await expect(client.getCalendars(1)).resolves.toBeDefined();
    expect(s.calls).toHaveLength(1);
  });

  it("fails fast with SessionExpiredError once exp has passed, without calling BAND", async () => {
    const s = scriptedFetch([]);
    const client = await makeClient(fakeJwt(NOW - HOUR), s.fetchImpl);
    await expect(client.getCalendars(1)).rejects.toBeInstanceOf(SessionExpiredError);
    expect(s.calls).toHaveLength(0);
  });

  it("maps BAND's expired-session 300 to SessionExpiredError", async () => {
    const s = scriptedFetch([EXPIRED]);
    const client = await makeClient(fakeJwt(NOW + 2 * HOUR), s.fetchImpl);
    const err = await client.getCalendars(1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionExpiredError);
    expect(err).toBeInstanceOf(AuthError);
  });

  it("leaves a plain signature failure as a generic AuthError", async () => {
    const s = scriptedFetch([
      () => jsonResponse({ result_code: 300, message: "You are not authorized." }),
    ]);
    const client = await makeClient(fakeJwt(NOW + 39 * HOUR), s.fetchImpl);
    const err = await client.getCalendars(1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect(err).not.toBeInstanceOf(SessionExpiredError);
  });

  it("reports expiry in browser mode too", async () => {
    const s = scriptedFetch([EXPIRED]);
    const client = await BandClient.create({
      cookies: { secretKey: '"a2V5"' },
      sendCookieHeader: false,
      credentials: "include",
      jwtSession: true,
      fetch: s.fetchImpl,
      jitterMs: null,
      readJitterMs: null,
    });
    await expect(client.getCalendars(1)).rejects.toBeInstanceOf(SessionExpiredError);
  });
});

describe("authFailureMessage (CLI)", () => {
  it("prints the short login hint for an expired session", () => {
    expect(authFailureMessage(new SessionExpiredError("session expired at …"))).toBe(
      "Session expired — run: bandstand login",
    );
    expect(SESSION_EXPIRED_HINT).toBe("Session expired — run: bandstand login");
  });

  it("names the failure and points at bandstand login — no DevTools walkthrough", () => {
    const msg = authFailureMessage(new AuthError("no band_session on file"));
    expect(msg).toBe("[auth] no band_session on file\nRun: bandstand login");
    expect(msg).not.toContain("DevTools");
  });
});
