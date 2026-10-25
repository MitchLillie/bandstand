#!/usr/bin/env node
// Live, read-only smoke test against the real BAND API using your saved session.
//
//   npm run smoke                 # builds, then runs this against dist/
//   node scripts/smoke.mjs --band 12345 --json
//
// NOT part of `npm test` / CI: it needs a real logged-in session. It never writes
// to your session file — the jar is loaded into memory, and any cookies the server
// rotates are kept in memory only (and reported by name). Never prints cookie values.

import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import {
  AuthError,
  BandClient,
  DEFAULT_STATE_PATH,
  FileCookieStore,
  MemoryCookieStore,
  classifyError,
  sessionInfo,
  yyyymmdd,
} from "../dist/index.js";

const REQUEST_TIMEOUT_MS = 15_000;
const GAP_MS = 150;
const WINDOW_DAYS = 14;

const { values } = parseArgs({
  options: { band: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean" } },
});
if (values.help) {
  console.log(
    "usage: npm run smoke [-- --band N] [-- --json]   (respects BAND_STATE / BAND_CONFIG)",
  );
  process.exit(0);
}

const statePath = DEFAULT_STATE_PATH;
const configPath = process.env.BAND_CONFIG ?? join(homedir(), ".band_config.json");

async function loadConfig() {
  try {
    return JSON.parse(await readFile(configPath, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw new Error(`${configPath}: ${err.message}`);
  }
}

/** Store that reads the real jar once, then keeps everything in memory. */
class ReadOnlyStore extends MemoryCookieStore {
  rotated = new Set();
  #original = {};
  static async from(path) {
    const jar = await new FileCookieStore(path).load();
    const store = new ReadOnlyStore(jar);
    store.#original = { ...jar };
    return store;
  }
  async save(jar) {
    for (const [name, value] of Object.entries(jar)) {
      if (this.#original[name] !== value) this.rotated.add(name);
    }
    await super.save(jar);
  }
}

const timedFetch = (url, init) =>
  globalThis.fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let session;
let stop = false;

async function check(name, fn) {
  if (stop) {
    results.push({ name, status: "skip", ms: 0, detail: "skipped (earlier failure)" });
    return undefined;
  }
  if (results.some((r) => r.ms > 0)) await sleep(GAP_MS);
  const t0 = performance.now();
  try {
    const { detail, value, skip } = await fn();
    const ms = Math.round(performance.now() - t0);
    results.push({ name, status: skip ? "skip" : "pass", ms, detail });
    return value;
  } catch (err) {
    const ms = Math.round(performance.now() - t0);
    const c = err?.classification ?? classifyError(err, session);
    results.push({
      name,
      status: "fail",
      ms,
      kind: c.kind,
      resultCode: c.resultCode,
      detail: c.hint,
    });
    return undefined;
  }
}

function calendarsOf(data) {
  return data?.internal_calendars ?? data?.calendars ?? data?.items ?? [];
}

async function main() {
  const config = await loadConfig();
  const band = values.band ? Number(values.band) : config.band;

  // 0. Session file + shape (local, no request).
  let store;
  let client;
  await check("session", async () => {
    try {
      await stat(statePath);
    } catch {
      throw new AuthError(`no session file at ${statePath}`);
    }
    store = await ReadOnlyStore.from(statePath);
    session = sessionInfo(await store.load());
    if (session.jwtExpired) {
      throw Object.assign(new Error("expired"), {
        classification: {
          kind: "session-expired",
          hint: `session JWT expired at ${session.jwtExpIso} — run \`bandstand login\``,
        },
      });
    }
    client = await BandClient.create({ store, fetch: timedFetch, jitterMs: null });
    const shape = session.isJwt
      ? `JWT, exp ${session.jwtExpIso ?? "?"} (${fmtDur(session.jwtExpiresInSec)})`
      : "opaque (not a JWT)";
    return { detail: `${shape}; secretKey present` };
  });
  if (!client) stop = true;
  if (band === undefined && !stop) {
    results.push({
      name: "config",
      status: "fail",
      ms: 0,
      kind: "config",
      detail: `no band_no — pass --band N or set "band" in ${configPath}`,
    });
    stop = true;
  }

  // 1. Signing / auth sanity — no special chars in the query string.
  const calendars = await check("auth (get_calendars)", async () => {
    const cals = calendarsOf(await client.getCalendars(band));
    return { value: cals, detail: `${cals.length} calendar(s)` };
  });
  if (!calendars) stop = true; // everything else would fail the same way

  await check("whoami (get_my_band_schedules)", async () => {
    const me = await client.getMe(band);
    return me
      ? { detail: `user_no ${me.user_no}` }
      : { detail: "ok, but no own schedules to infer user_no from" };
  });

  const groups = await check("groups (get_member_groups)", async () => {
    const items = (await client.getMemberGroups(band)).items ?? [];
    return { value: items, detail: `${items.length} group(s)` };
  });

  await check("group members (member_group filter)", async () => {
    const first = groups?.[0];
    if (!first) return { skip: true, detail: "no member groups on this band" };
    const data = await client.getGroupMembers(band, first.member_group_id);
    const n = (data.members ?? data.items ?? []).length;
    return { detail: `group ${first.member_group_id}: ${n} member(s)` };
  });

  const today = new Date();
  const start = yyyymmdd(today);
  const end = yyyymmdd(new Date(today.getTime() + WINDOW_DAYS * 86_400_000));
  const events = [];

  await check(`schedules: default calendar, ${WINDOW_DAYS}d`, async () => {
    const page = await client.getSchedules(band, start, end, { maxPages: 2 });
    events.push(...page.items);
    return { detail: `${page.items.length} event(s) ${start}–${end}` };
  });

  // A non-default calendar exercises the JSON `calendars` param with a calendar_id —
  // [{"calendar_id":N,"is_default":false}] must be fully percent-encoded AND signed as sent.
  const other =
    calendars?.find((c) => !c.is_default && c.calendar_id === config.calendar) ??
    calendars?.find((c) => !c.is_default && c.calendar_id != null);
  await check("schedules: non-default calendar (JSON param)", async () => {
    if (!other) return { skip: true, detail: "band has no non-default calendar" };
    const page = await client.getSchedules(band, start, end, {
      calendars: [{ calendar_id: other.calendar_id, is_default: false }],
      maxPages: 2,
    });
    events.push(...page.items);
    return { detail: `calendar ${other.calendar_id}: ${page.items.length} event(s)` };
  });

  await check("schedule detail (get_schedule)", async () => {
    const ev = events.find((e) => e.schedule_id);
    if (!ev) return { skip: true, detail: `no events in the next ${WINDOW_DAYS} days` };
    const s = await client.getSchedule(band, ev.schedule_id);
    return { detail: `${ev.schedule_id}: ${s.schedule_id ? "ok" : "empty payload"}` };
  });

  report({ band, rotated: store ? [...store.rotated] : [] });
}

function fmtDur(sec) {
  if (sec === undefined) return "?";
  const abs = Math.abs(sec);
  const s = abs >= 3600 ? `${(abs / 3600).toFixed(1)}h` : `${Math.round(abs / 60)}m`;
  return sec >= 0 ? `expires in ${s}` : `expired ${s} ago`;
}

function report({ band, rotated }) {
  const failed = results.filter((r) => r.status === "fail");
  const passed = results.filter((r) => r.status === "pass").length;
  const skipped = results.filter((r) => r.status === "skip").length;
  const totalMs = results.reduce((a, r) => a + r.ms, 0);

  if (values.json) {
    console.log(
      JSON.stringify(
        {
          ok: failed.length === 0,
          band,
          statePath,
          session: session ?? null,
          rotatedCookies: rotated,
          checks: results,
          summary: { passed, failed: failed.length, skipped, totalMs },
        },
        null,
        2,
      ),
    );
  } else {
    const icon = { pass: "✓", fail: "✗", skip: "–" };
    const width = Math.max(...results.map((r) => r.name.length));
    for (const r of results) {
      const ms = `${r.ms}ms`.padStart(7);
      console.log(`${icon[r.status]} ${r.name.padEnd(width)} ${ms}  ${r.detail ?? ""}`);
    }
    console.log("");
    console.log(
      `${failed.length === 0 ? "PASS" : "FAIL"}: ${passed} passed, ${failed.length} failed, ` +
        `${skipped} skipped in ${totalMs}ms (band ${band ?? "?"}, session ${statePath})`,
    );
    if (rotated.length) {
      console.log(`note: server rotated ${rotated.join(", ")} — kept in memory, NOT saved to disk`);
    }
    if (failed.length) {
      const kinds = [...new Set(failed.map((r) => r.kind))];
      console.log(`failure kind: ${kinds.join(", ")}`);
    }
  }
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(`smoke: unexpected crash: ${err?.stack ?? err}`);
  process.exitCode = 1;
});
