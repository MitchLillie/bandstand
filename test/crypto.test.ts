import { describe, expect, it } from "vitest";
import { extractPath, importHmacKey, signPath } from "../src/crypto";

describe("extractPath", () => {
  it("strips scheme and host, keeping path + query", () => {
    expect(extractPath("https://api-usw.band.us/v1.6.0/get_schedules?band_no=42")).toBe(
      "/v1.6.0/get_schedules?band_no=42",
    );
  });

  it("percent-encodes apostrophes (matches the web client)", () => {
    expect(extractPath("https://api-usw.band.us/x?q=it's")).toBe("/x?q=it%27s");
  });
});

describe("signPath", () => {
  it("matches a known HMAC-SHA256 base64 digest", async () => {
    const key = await importHmacKey("s3cr3t");
    const md = await signPath(
      key,
      "https://api-usw.band.us/v1.6.0/get_schedules?band_no=42&ts=1700000000000",
    );
    expect(md).toBe("Boixu035eGFZs7dWcJxzoOkm/lt/oLZi51MG80NKDhA=");
  });
});
