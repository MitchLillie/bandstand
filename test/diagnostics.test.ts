import { describe, expect, it } from "vitest";
import { BandClient } from "../src/client";
import { classifyError, jwtExp, resultCodeOf, sessionInfo } from "../src/diagnostics";
import { AuthError, BandApiError } from "../src/errors";
import { MemoryCookieStore } from "../src/store";

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const fakeJwt = (claims: Record<string, unknown>) =>
  `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url(claims)}.c2ln`;

const NOW = Date.UTC(2026, 9, 23, 12, 0, 0);
const FUTURE = NOW / 1000 + 3600;
const PAST = NOW / 1000 - 60;

describe("sessionInfo", () => {
  it("decodes only the exp of a JWT session", () => {
    const info = sessionInfo(
      { band_session: fakeJwt({ exp: FUTURE, hmacKey: "nope" }), secretKey: '"k"' },
      NOW,
    );
    expect(info).toEqual({
      hasBandSession: true,
      hasSecretKey: true,
      isJwt: true,
      jwtExp: FUTURE,
      jwtExpIso: new Date(FUTURE * 1000).toISOString(),
      jwtExpiresInSec: 3600,
      jwtExpired: false,
    });
    expect(JSON.stringify(info)).not.toContain("nope");
  });

  it("flags an expired JWT", () => {
    expect(sessionInfo({ band_session: fakeJwt({ exp: PAST }) }, NOW).jwtExpired).toBe(true);
  });

  it("treats opaque tokens as non-JWT", () => {
    const info = sessionInfo({ band_session: "opaque-token", secretKey: "k" }, NOW);
    expect(info.isJwt).toBe(false);
    expect(info.jwtExp).toBeUndefined();
  });

  it("tolerates garbage JWT payloads", () => {
    expect(jwtExp("a.!!!.c")).toBeUndefined();
    expect(jwtExp(`a.${b64url({ exp: "soon" })}.c`)).toBeUndefined();
  });
});

describe("classifyError", () => {
  it("missing session → session-missing with a login hint", () => {
    for (const msg of ["no band_session on file", "no secretKey cookie on file — …"]) {
      const c = classifyError(new AuthError(msg));
      expect(c.kind).toBe("session-missing");
      expect(c.hint).toContain("bandstand login");
    }
  });

  it("result_code 300 (thrown as AuthError by the client) → auth, mentions signing", () => {
    const err = new AuthError(
      'API auth error: {"result_code":300,"result_data":{"message":"You are not authorized."}}',
    );
    expect(resultCodeOf(err)).toBe(300);
    const c = classifyError(err, sessionInfo({ band_session: fakeJwt({ exp: FUTURE }) }, NOW));
    expect(c).toMatchObject({ kind: "auth", resultCode: 300 });
    expect(c.hint).toMatch(/base64url/);
    expect(c.hint).toMatch(/makeMd/);
  });

  it("result_code 300 on an expired JWT → session-expired", () => {
    const err = new BandApiError("API error (result_code=300)", 300);
    const c = classifyError(err, sessionInfo({ band_session: fakeJwt({ exp: PAST }) }, NOW));
    expect(c.kind).toBe("session-expired");
    expect(c.hint).toContain("bandstand login");
  });

  it("HTTP 401/403 → auth", () => {
    expect(classifyError(new AuthError("HTTP 403 on /v2.0.0/get_calendars")).kind).toBe("auth");
  });

  it.each([251, 200])("result_code %i → params", (code) => {
    const c = classifyError(new BandApiError(`API error (result_code=${code})`, code));
    expect(c).toMatchObject({ kind: "params", resultCode: code });
  });

  it("other result codes → api", () => {
    expect(classifyError(new BandApiError("API error (result_code=1003)", 1003))).toMatchObject({
      kind: "api",
      resultCode: 1003,
    });
    expect(classifyError(new BandApiError("HTTP 502 on /x: bad gateway")).kind).toBe("api");
  });

  it("fetch failures and timeouts → network", () => {
    const dns = new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } });
    expect(classifyError(dns)).toMatchObject({ kind: "network" });
    expect(classifyError(dns).hint).toContain("ENOTFOUND");
    expect(classifyError(new DOMException("timed out", "TimeoutError")).kind).toBe("network");
  });

  it("undecodable secretKey → session-invalid", () => {
    expect(classifyError(new DOMException("bad", "InvalidCharacterError")).kind).toBe(
      "session-invalid",
    );
  });

  it("classifies a real client 300 end-to-end", async () => {
    const client = await BandClient.create({
      cookies: { band_session: fakeJwt({ exp: FUTURE }), secretKey: "AAAA" },
      store: new MemoryCookieStore(),
      jitterMs: null,
      fetch: (async () =>
        new Response(
          JSON.stringify({ result_code: 300, result_data: { message: "You are not authorized." } }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as typeof fetch,
    });
    const err = await client.getCalendars(1).catch((e: unknown) => e);
    expect(classifyError(err).kind).toBe("auth");
  });
});
