import {
  BROWSER_UA,
  DEFAULT_AKEY,
  DEFAULT_API_BASE,
  DEFAULT_JITTER_MS,
  DEFAULT_TIME_ZONE_ID,
  DEFAULT_TIME_ZONE_OFFSET_MS,
} from "./constants";
import {
  type CookieJar,
  extractSecret,
  mergeSetCookies,
  parseCookieHeader,
  serializeCookieHeader,
} from "./cookies";
import { importHmacKey, signPath } from "./crypto";
import { AuthError, BandApiError } from "./errors";
import { type CookieStore, MemoryCookieStore } from "./store";
import type {
  BandApiResponse,
  CalendarRef,
  CalendarsResult,
  CreateScheduleResult,
  DeleteScheduleResult,
  MemberGroupsResult,
  MembersResult,
  MyBandSchedulesResult,
  Paging,
  RecurringEditType,
  RsvpState,
  Schedule,
  SchedulesPage,
  SetRsvpResult,
} from "./types";

export interface BandClientOptions {
  /** Seed cookies — a jar object, or a `document.cookie`-style string. */
  cookies?: CookieJar | string;
  /** Where to load/persist the cookie jar. Defaults to in-memory. */
  store?: CookieStore;
  /** Injectable `fetch` (e.g. a curl-impersonate-backed one). Defaults to global. */
  fetch?: typeof globalThis.fetch;
  /** Injectable Web Crypto implementation. Defaults to `globalThis.crypto`. */
  crypto?: Crypto;
  apiBase?: string;
  akey?: string;
  timeZoneId?: string;
  timeZoneOffsetMs?: number;
  /** Inclusive [min, max] ms gap between calls; `null` disables pacing. */
  jitterMs?: readonly [number, number] | null;
  /** Run the calendar-page warm-up before the first write. Default true. */
  warmUp?: boolean;
  /** Injectable clock (ms). Defaults to `Date.now`. */
  now?: () => number;
  /** Injectable sleep. Defaults to `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Send a `Cookie` header built from the jar. Default `true` (Node). In a browser
   * set this `false`: `Cookie` is a forbidden header there, and the runtime attaches
   * session cookies itself via {@link credentials}. In that mode only `secretKey` is
   * required (to sign); `band_session` is supplied ambiently by the browser.
   */
  sendCookieHeader?: boolean;
  /** `credentials` mode passed to `fetch` — e.g. `"include"` in a browser extension. */
  credentials?: RequestCredentials;
}

interface ResolvedConfig {
  store: CookieStore;
  fetchImpl: typeof globalThis.fetch;
  crypto: Crypto;
  apiBase: string;
  akey: string;
  timeZoneId: string;
  timeZoneOffsetMs: number;
  jitterMs: readonly [number, number] | null;
  warmUp: boolean;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  sendCookieHeader: boolean;
  credentials: RequestCredentials | undefined;
}

const AUTH_HINTS = ["auth", "login", "session", "token", "unauth"];

type Primitive = string | number | boolean;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Read `Set-Cookie` headers across runtimes (undici exposes `getSetCookie`). */
function readSetCookies(headers: Headers): string[] {
  const getter = (headers as { getSetCookie?: () => string[] }).getSetCookie;
  return typeof getter === "function" ? getter.call(headers) : [];
}

/**
 * Unofficial client for BAND's (band.us) internal calendar API.
 *
 * Construct with the async {@link BandClient.create} factory — it loads the cookie
 * jar, validates that both `band_session` and `secretKey` are present, and imports
 * the HMAC key used to sign every request.
 */
export class BandClient {
  private readonly cfg: ResolvedConfig;
  private readonly hmacKey: CryptoKey;
  private jar: CookieJar;
  private lastCallAt = 0;
  private warmed = false;
  private referer = "https://www.band.us/";

  private constructor(cfg: ResolvedConfig, hmacKey: CryptoKey, jar: CookieJar) {
    this.cfg = cfg;
    this.hmacKey = hmacKey;
    this.jar = jar;
  }

  static async create(options: BandClientOptions = {}): Promise<BandClient> {
    const store = options.store ?? new MemoryCookieStore();
    const jar = await store.load();
    const seed =
      typeof options.cookies === "string" ? parseCookieHeader(options.cookies) : options.cookies;
    Object.assign(jar, seed ?? {});

    const sendCookieHeader = options.sendCookieHeader ?? true;
    if (sendCookieHeader && !jar.band_session) {
      throw new AuthError("no band_session on file");
    }
    const secret = extractSecret(jar);
    if (!secret) {
      throw new AuthError(
        "no secretKey cookie on file — it's HttpOnly so `copy(document.cookie)` won't grab it. " +
          "Copy it from DevTools → Application → Cookies.",
      );
    }

    const crypto = options.crypto ?? globalThis.crypto;
    const hmacKey = await importHmacKey(secret, crypto);
    const cfg: ResolvedConfig = {
      store,
      // Bind the default global fetch to the global scope. Calling it detached
      // (as `this.cfg.fetchImpl(...)`) throws "Illegal invocation" in browsers and
      // service workers, where fetch requires its `this` to be the global object.
      fetchImpl: options.fetch ?? globalThis.fetch.bind(globalThis),
      crypto,
      apiBase: options.apiBase ?? DEFAULT_API_BASE,
      akey: options.akey ?? DEFAULT_AKEY,
      timeZoneId: options.timeZoneId ?? DEFAULT_TIME_ZONE_ID,
      timeZoneOffsetMs: options.timeZoneOffsetMs ?? DEFAULT_TIME_ZONE_OFFSET_MS,
      jitterMs: options.jitterMs === undefined ? DEFAULT_JITTER_MS : options.jitterMs,
      warmUp: options.warmUp ?? true,
      now: options.now ?? Date.now,
      sleep: options.sleep ?? defaultSleep,
      sendCookieHeader,
      credentials: options.credentials,
    };

    await store.save(jar);
    return new BandClient(cfg, hmacKey, jar);
  }

  /** Names of the cookies currently in the jar (no values). */
  cookieNames(): string[] {
    return Object.keys(this.jar);
  }

  // ---- pacing / warm-up ----

  private async jitter(): Promise<void> {
    if (!this.cfg.jitterMs || this.lastCallAt === 0) return;
    const [min, max] = this.cfg.jitterMs;
    const elapsed = this.cfg.now() - this.lastCallAt;
    const target = min + Math.random() * (max - min);
    if (elapsed < target) await this.cfg.sleep(target - elapsed);
  }

  /** Mimic a calendar-page visit before the first write. Best-effort. */
  private async warmUp(bandNo: number): Promise<void> {
    if (this.warmed || !this.cfg.warmUp) return;
    this.warmed = true;
    try {
      await this.call("GET", "/v2.0.0/touch_band_access", { params: { band_no: bandNo } });
      await this.call("GET", "/v2.0.0/get_calendars", { params: { band_no: bandNo } });
    } catch {
      // warm-up failures are non-fatal
    }
  }

  // ---- core call ----

  private appHeaders(): Record<string, string> {
    return {
      language: "en",
      "device-time-zone-id": this.cfg.timeZoneId,
      "device-time-zone-ms-offset": String(this.cfg.timeZoneOffsetMs),
      akey: this.cfg.akey,
      origin: "https://www.band.us",
      referer: this.referer,
      "user-agent": BROWSER_UA,
    };
  }

  private async call<T>(
    method: "GET" | "POST",
    path: string,
    opts: { params?: Record<string, Primitive>; body?: Record<string, Primitive> } = {},
  ): Promise<T> {
    await this.jitter();

    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(opts.params ?? {})) params.set(key, String(value));
    params.set("ts", String(this.cfg.now()));
    const url = `${this.cfg.apiBase}${path}?${params.toString()}`;

    const headers: Record<string, string> = {
      ...this.appHeaders(),
      md: await signPath(this.hmacKey, url, this.cfg.crypto),
    };
    // In a browser `Cookie` is forbidden; the runtime sends cookies via `credentials`.
    if (this.cfg.sendCookieHeader) {
      headers.cookie = serializeCookieHeader(this.jar);
    }
    const init: RequestInit = { method, headers };
    if (this.cfg.credentials) init.credentials = this.cfg.credentials;
    if (method === "POST") {
      headers["content-type"] = "application/x-www-form-urlencoded; charset=UTF-8";
      const form = new URLSearchParams();
      for (const [key, value] of Object.entries(opts.body ?? {})) form.set(key, String(value));
      init.body = form.toString();
    }

    const res = await this.cfg.fetchImpl(url, init);
    this.lastCallAt = this.cfg.now();

    // Persist any server-rotated cookies (band_session, ai, …).
    if (mergeSetCookies(this.jar, readSetCookies(res.headers))) {
      await this.cfg.store.save(this.jar);
    }

    if (res.status === 401 || res.status === 403) {
      throw new AuthError(`HTTP ${res.status} on ${path}`);
    }
    if (!res.ok) {
      const body = (await res.text()).slice(0, 200);
      throw new BandApiError(`HTTP ${res.status} on ${path}: ${body}`);
    }

    const json = (await res.json()) as BandApiResponse<T>;
    if (json.result_code !== 1) {
      const blob = JSON.stringify(json).toLowerCase();
      if (AUTH_HINTS.some((hint) => blob.includes(hint))) {
        throw new AuthError(`API auth error: ${JSON.stringify(json)}`);
      }
      throw new BandApiError(`API error (result_code=${json.result_code})`, json.result_code, json);
    }
    return json.result_data;
  }

  // ---- high-level ----

  getCalendars(bandNo: number): Promise<CalendarsResult> {
    return this.call("GET", "/v2.0.0/get_calendars", {
      params: { band_no: bandNo, calendar_types: "internal" },
    });
  }

  getMembers(bandNo: number): Promise<MembersResult> {
    // The web client enumerates members via the `add_schedule_sharer` filter;
    // `filter=member` is not valid and returns result_code 200 ("Temporary error").
    // Note: this list excludes the current user (you can't share with yourself).
    return this.call("GET", "/v2.0.0/get_members_of_band_with_filter", {
      params: { band_no: bandNo, filter: "add_schedule_sharer" },
    });
  }

  getMemberGroups(bandNo: number): Promise<MemberGroupsResult> {
    return this.call("GET", "/v2.1.0/get_member_groups", { params: { band_no: bandNo } });
  }

  getGroupMembers(bandNo: number, groupId: number): Promise<MembersResult> {
    return this.call("GET", "/v2.0.0/get_members_of_band_with_filter", {
      params: { band_no: bandNo, filter: "member_group", param1: groupId },
    });
  }

  getSchedule(bandNo: number, scheduleId: string): Promise<Schedule> {
    return this.call("GET", "/v1.6.0/get_schedule", {
      params: { band_no: bandNo, schedule_id: scheduleId, for_schedule_detail: "true" },
    });
  }

  /**
   * Fetch schedules in a `[startYmd, endYmd]` window, following `paging.next_params`
   * to aggregate every page (BAND paginates large windows). `maxPages` is a safety cap.
   */
  async getSchedules(
    bandNo: number,
    startYmd: string,
    endYmd: string,
    opts: { calendars?: CalendarRef[]; maxPages?: number } = {},
  ): Promise<SchedulesPage> {
    const calendars = opts.calendars ?? [{ is_default: true }];
    const maxPages = opts.maxPages ?? 50;
    const baseParams: Record<string, Primitive> = {
      band_no: bandNo,
      start_at: startYmd,
      future_end_at: endYmd,
      calendars: JSON.stringify(calendars),
    };

    const items: Schedule[] = [];
    let extra: Record<string, Primitive> = {};
    let lastPaging: Paging | undefined;

    for (let page = 0; page < maxPages; page++) {
      const data = await this.call<SchedulesPage>("GET", "/v1.6.0/get_schedules", {
        params: { ...baseParams, ...extra },
      });
      items.push(...(data.items ?? []));
      lastPaging = data.paging;
      const next = data.paging?.next_params;
      if (!next) break;
      extra = pagingToParams(next);
    }

    return { items, paging: lastPaging };
  }

  async createSchedule(
    bandNo: number,
    schedule: Schedule,
    opts: { announceable?: boolean } = {},
  ): Promise<CreateScheduleResult> {
    this.referer = `https://www.band.us/band/${bandNo}/calendar`;
    await this.warmUp(bandNo);
    return this.call("POST", "/v2.0.0/create_schedule", {
      body: {
        band_no: bandNo,
        schedule: JSON.stringify(schedule),
        announceable: String(opts.announceable ?? false),
        purpose: "create",
      },
    });
  }

  async updateSchedule(
    bandNo: number,
    scheduleId: string,
    schedule: Schedule,
    opts: { notify?: boolean; recurringEditType?: RecurringEditType } = {},
  ): Promise<CreateScheduleResult> {
    this.referer = `https://www.band.us/band/${bandNo}/calendar`;
    await this.warmUp(bandNo);
    return this.call("POST", "/v2.0.3/update_schedule", {
      body: {
        band_no: bandNo,
        schedule_id: scheduleId,
        schedule: JSON.stringify(schedule),
        notify_to_members: String(opts.notify ?? false),
        recurring_edit_type: opts.recurringEditType ?? "ALL",
      },
    });
  }

  /**
   * Delete a schedule. For a recurring series, `repeatEditType` controls scope
   * (`ALL` removes every occurrence); it's harmless on a one-off event. Note BAND
   * spells this param `repeat_edit_type` here, unlike `update_schedule`.
   */
  deleteSchedule(
    bandNo: number,
    scheduleId: string,
    opts: { repeatEditType?: RecurringEditType; notify?: boolean } = {},
  ): Promise<DeleteScheduleResult> {
    this.referer = `https://www.band.us/band/${bandNo}/calendar`;
    return this.call("GET", "/v1/schedule/delete_schedule", {
      params: {
        band_no: bandNo,
        schedule_id: scheduleId,
        repeat_edit_type: opts.repeatEditType ?? "ALL",
        notify_to_members: String(opts.notify ?? false),
      },
    });
  }

  getMyBandSchedules(bandNo: number): Promise<MyBandSchedulesResult> {
    return this.call("GET", "/v2.0.0/get_my_band_schedules", { params: { band_no: bandNo } });
  }

  /** Resolve the current user's `{ user_no, name }` from their own schedules, or null. */
  async getMe(bandNo: number): Promise<{ user_no: number; name: string } | null> {
    const data = await this.getMyBandSchedules(bandNo);
    const owner = (data.items ?? data.schedules ?? [])[0]?.owner;
    return owner?.user_no ? { user_no: owner.user_no, name: owner.name ?? "" } : null;
  }

  /** Set a user's RSVP on a schedule (defaults to the given user). */
  setRsvp(
    bandNo: number,
    scheduleId: string,
    state: RsvpState,
    userNo: number,
  ): Promise<SetRsvpResult> {
    this.referer = `https://www.band.us/band/${bandNo}/calendar`;
    return this.call("POST", "/v2.0.0/set_schedule_rsvp_states", {
      body: {
        band_no: bandNo,
        schedule_id: scheduleId,
        target_users: JSON.stringify([{ user_no: userNo }]),
        rsvp_state: state,
      },
    });
  }
}

function pagingToParams(next: string | Record<string, unknown>): Record<string, Primitive> {
  if (typeof next === "string") {
    return Object.fromEntries(new URLSearchParams(next));
  }
  const out: Record<string, Primitive> = {};
  for (const [key, value] of Object.entries(next)) {
    if (value != null) out[key] = String(value);
  }
  return out;
}
