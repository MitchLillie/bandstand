import { describe, expect, it } from "vitest";
import {
  extractSecret,
  isJwtSession,
  mergeSetCookies,
  parseCookieHeader,
  serializeCookieHeader,
  sessionExpiresAt,
} from "../src/cookies";

describe("sessionExpiresAt", () => {
  const jwt = (payload: unknown) =>
    `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;

  it("reads a JWT band_session's exp claim, in ms", () => {
    expect(sessionExpiresAt({ band_session: jwt({ exp: 1_792_961_500 }) })).toBe(1_792_961_500_000);
  });

  it("prefers the ai cookie's hex expiry, like the web client", () => {
    const ai = `x,${(1_700_000_000_000).toString(16)}`;
    expect(sessionExpiresAt({ band_session: jwt({ exp: 1 }), ai })).toBe(1_700_000_000_000);
  });

  it("is undefined for opaque tokens and unparseable JWTs", () => {
    expect(sessionExpiresAt({ band_session: "opaque" })).toBeUndefined();
    expect(sessionExpiresAt({ band_session: "a.%%%.c" })).toBeUndefined();
    expect(sessionExpiresAt({ band_session: jwt({ sub: 1 }) })).toBeUndefined();
    expect(sessionExpiresAt({})).toBeUndefined();
  });
});

describe("parseCookieHeader", () => {
  it("parses a document.cookie string", () => {
    expect(parseCookieHeader("band_session=abc; language=en")).toEqual({
      band_session: "abc",
      language: "en",
    });
  });

  it("treats a bare value as band_session", () => {
    expect(parseCookieHeader("just-a-token")).toEqual({ band_session: "just-a-token" });
  });

  it("strips surrounding quotes and preserves '=' in values (base64 padding)", () => {
    expect(parseCookieHeader('"band_session=ab=="')).toEqual({ band_session: "ab==" });
  });
});

describe("serializeCookieHeader", () => {
  it("never sends secretKey to the API host", () => {
    const header = serializeCookieHeader({ band_session: "x", secretKey: "k", language: "en" });
    expect(header).toBe("band_session=x; language=en");
    expect(header).not.toContain("secretKey");
  });
});

describe("mergeSetCookies", () => {
  it("applies rotated values and reports change", () => {
    const jar = { band_session: "old" };
    const changed = mergeSetCookies(jar, ["band_session=new; Path=/; HttpOnly", "ai=123; Secure"]);
    expect(changed).toBe(true);
    expect(jar).toEqual({ band_session: "new", ai: "123" });
  });

  it("reports no change when values are identical", () => {
    const jar = { band_session: "same" };
    expect(mergeSetCookies(jar, ["band_session=same; Path=/"])).toBe(false);
  });
});

describe("extractSecret", () => {
  it("strips BAND's wrapping quotes", () => {
    expect(extractSecret({ secretKey: '"abc123"' })).toBe("abc123");
  });
  it("returns undefined when absent", () => {
    expect(extractSecret({ band_session: "x" })).toBeUndefined();
  });
});

describe("isJwtSession", () => {
  it("detects a three-part JWT band_session", () => {
    expect(isJwtSession({ band_session: "eyJh.eyJw.sig" })).toBe(true);
    expect(isJwtSession({ band_session: "opaque-token" })).toBe(false);
    expect(isJwtSession({})).toBe(false);
  });
});
