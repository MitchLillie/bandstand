import { describe, expect, it } from "vitest";
import {
  extractSecret,
  mergeSetCookies,
  parseCookieHeader,
  serializeCookieHeader,
} from "../src/cookies";

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
