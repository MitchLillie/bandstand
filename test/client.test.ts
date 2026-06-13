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

  it("deleteSchedule issues a GET to /v1/schedule/delete_schedule with the right params", async () => {
    let captured = "";
    const fetchImpl = (async (url: string | URL) => {
      captured = String(url);
      return jsonResponse({ result_code: 1, result_data: { message: "Request completed." } });
    }) as typeof fetch;
    const client = await BandClient.create({
      cookies: BASE_COOKIES,
      fetch: fetchImpl,
      jitterMs: null,
    });
    await client.deleteSchedule(103117926, "4/103117926/1/19700101");
    expect(captured).toContain("/v1/schedule/delete_schedule");
    expect(captured).toContain("band_no=103117926");
    expect(captured).toContain("repeat_edit_type=ALL");
    expect(captured).toContain("notify_to_members=false");
    expect(captured).toContain(encodeURIComponent("4/103117926/1/19700101"));
  });
});

describe("browser mode (sendCookieHeader: false)", () => {
  it("works with only secretKey, omits the Cookie header, and sets credentials", async () => {
    let init: RequestInit | undefined;
    const fetchImpl = (async (_url: string | URL, opts?: RequestInit) => {
      init = opts;
      return jsonResponse({ result_code: 1, result_data: { internal_calendars: [] } });
    }) as typeof fetch;

    // No band_session — the browser would supply it ambiently.
    const client = await BandClient.create({
      cookies: { secretKey: '"key"' },
      sendCookieHeader: false,
      credentials: "include",
      fetch: fetchImpl,
      jitterMs: null,
    });
    await client.getCalendars(42);

    const headers = init?.headers as Record<string, string>;
    expect(headers.md).toMatch(/=$/); // still signed
    expect(headers.cookie).toBeUndefined(); // Cookie header omitted
    expect(init?.credentials).toBe("include");
  });

  it("still requires band_session when sendCookieHeader is true (default)", async () => {
    await expect(BandClient.create({ cookies: { secretKey: "k" } })).rejects.toBeInstanceOf(
      AuthError,
    );
  });
});

describe("RSVP + whoami", () => {
  it("setRsvp POSTs set_schedule_rsvp_states with target_users + rsvp_state", async () => {
    let captured = { url: "", body: "" };
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      captured = { url: String(url), body: String(init?.body ?? "") };
      return jsonResponse({ result_code: 1, result_data: {} });
    }) as typeof fetch;
    const client = await BandClient.create({
      cookies: BASE_COOKIES,
      fetch: fetchImpl,
      jitterMs: null,
    });
    await client.setRsvp(103117926, "4/1/2/3", "ATTENDANCE", 999);
    expect(captured.url).toContain("/v2.0.0/set_schedule_rsvp_states");
    expect(captured.body).toContain("rsvp_state=ATTENDANCE");
    expect(captured.body).toContain(encodeURIComponent(JSON.stringify([{ user_no: 999 }])));
  });

  it("getMe resolves the owner of my first schedule, or null", async () => {
    const clientReturning = (items: unknown[]) =>
      BandClient.create({
        cookies: BASE_COOKIES,
        jitterMs: null,
        fetch: (async () =>
          jsonResponse({ result_code: 1, result_data: { items } })) as typeof fetch,
      });

    const c1 = await clientReturning([{ owner: { user_no: 42, name: "Me" } }]);
    expect(await c1.getMe(1)).toEqual({ user_no: 42, name: "Me" });

    const c2 = await clientReturning([]);
    expect(await c2.getMe(1)).toBeNull();
  });
});
