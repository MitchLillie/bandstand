import { describe, expect, it } from "vitest";
import { BandClient } from "../src/client";
import { AuthError, BandApiError } from "../src/errors";
import { MemoryCookieStore } from "../src/store";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const BASE_COOKIES = { band_session: "sess", secretKey: '"key"', language: "en" };

describe("BandClient.create", () => {
  it("rejects when band_session is missing", async () => {
    await expect(BandClient.create({ cookies: { secretKey: "k" } })).rejects.toBeInstanceOf(
      AuthError,
    );
  });

  it("rejects when secretKey is missing", async () => {
    await expect(BandClient.create({ cookies: { band_session: "x" } })).rejects.toBeInstanceOf(
      AuthError,
    );
  });
});

describe("BandClient request pipeline", () => {
  it("signs the request, adds ts, and never sends secretKey as a cookie", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), headers: init?.headers as Record<string, string> });
      return jsonResponse({ result_code: 1, result_data: { internal_calendars: [] } });
    }) as typeof fetch;

    const client = await BandClient.create({
      cookies: BASE_COOKIES,
      store: new MemoryCookieStore(),
      fetch: fetchImpl,
      jitterMs: null,
      now: () => 1_700_000_000_000,
    });

    const data = await client.getCalendars(42);
    expect(data).toEqual({ internal_calendars: [] });

    const call = calls[0];
    expect(call?.url).toContain("band_no=42");
    expect(call?.url).toContain("ts=1700000000000");
    expect(call?.url).toContain("calendar_types=internal");
    expect(call?.headers.md).toMatch(/=$/); // base64 digest
    expect(call?.headers.cookie).toContain("band_session=sess");
    expect(call?.headers.cookie).not.toContain("secretKey");
  });

  it("maps a generic non-success result_code to BandApiError", async () => {
    const client = await BandClient.create({
      cookies: BASE_COOKIES,
      fetch: (async () => jsonResponse({ result_code: 251, result_data: {} })) as typeof fetch,
      jitterMs: null,
    });
    await expect(client.getCalendars(1)).rejects.toBeInstanceOf(BandApiError);
  });

  it("maps an auth-flavored failure to AuthError", async () => {
    const client = await BandClient.create({
      cookies: BASE_COOKIES,
      fetch: (async () =>
        jsonResponse({ result_code: 300, message: "You are not authorized." })) as typeof fetch,
      jitterMs: null,
    });
    await expect(client.getCalendars(1)).rejects.toBeInstanceOf(AuthError);
  });

  it("follows paging.next_params across pages", async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n += 1;
      if (n === 1) {
        return jsonResponse({
          result_code: 1,
          result_data: { items: [{ schedule_id: "a" }], paging: { next_params: "page=2" } },
        });
      }
      return jsonResponse({
        result_code: 1,
        result_data: { items: [{ schedule_id: "b" }], paging: { next_params: null } },
      });
    }) as typeof fetch;

    const client = await BandClient.create({
      cookies: BASE_COOKIES,
      fetch: fetchImpl,
      jitterMs: null,
    });
    const page = await client.getSchedules(1, "20260101", "20260301");
    expect(page.items.map((i) => i.schedule_id)).toEqual(["a", "b"]);
    expect(n).toBe(2);
  });
});
