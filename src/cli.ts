#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { BandClient } from "./client";
import { COOKIE_INSTRUCTIONS } from "./constants";
import { parseCookieHeader } from "./cookies";
import { AuthError, BandApiError } from "./errors";
import { dateWindow, fmtLocal, parseIso, scheduleUrl } from "./format";
import { FileCookieStore } from "./node/file-store";
import { applySharerFlags, parseUserList, stripForCreate } from "./schedule";
import type { CalendarRef, Member, MembersResult, Schedule } from "./types";

type Values = Record<string, string | boolean | undefined>;

interface Config {
  band?: number;
  calendar?: number;
  me?: number;
}

interface Command {
  summary: string;
  usage?: string;
  allowPositionals?: boolean;
  options: Record<string, { type: "string" | "boolean"; short?: string }>;
  run: (values: Values, positionals: string[], config: Config) => Promise<void>;
}

// ---- small helpers ----

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function str(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function num(value: string | boolean | undefined): number | undefined {
  const s = str(value);
  if (s === undefined) return undefined;
  const n = Number(s);
  return Number.isNaN(n) ? undefined : n;
}

function membersOf(data: MembersResult): Member[] {
  return data.members ?? data.items ?? [];
}

function requireBand(values: Values, config: Config): number {
  const band = num(values.band) ?? config.band;
  if (band === undefined) {
    fail('--band <band_no> required (or set "band" in ~/.band_config.json)');
  }
  return band;
}

function eventCalendars(calendar: number | undefined): CalendarRef[] {
  return calendar ? [{ is_default: false, calendar_id: calendar }] : [{ is_default: true }];
}

/** `YYYY-MM-DD HH:MM` in local time. */
function localStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(cmd, [url], {
      stdio: "ignore",
      detached: true,
      shell: process.platform === "win32",
    }).unref();
  } catch {
    // best-effort; the URL is also printed in the instructions
  }
}

async function promptCookie(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await rl.question("paste cookie: ")).trim();
  } finally {
    rl.close();
  }
}

async function saveCookies(store: FileCookieStore, raw: string): Promise<void> {
  const jar = parseCookieHeader(raw);
  if (!jar.band_session) fail("no band_session found in input");
  await store.save(jar);
}

async function reprompt(store: FileCookieStore, err: AuthError): Promise<void> {
  console.error(`\n[auth] ${err.message}`);
  console.error(COOKIE_INSTRUCTIONS);
  openBrowser("https://www.band.us/");
  const raw = await promptCookie();
  if (!raw) fail("aborted");
  await saveCookies(store, raw);
}

/**
 * Run an operation with a freshly loaded client. If auth fails — either at
 * construction or mid-call — and we're on a TTY, reprompt for cookies and retry once.
 * Every command goes through here, so reads and writes get identical handling.
 */
async function run<T>(fn: (client: BandClient) => Promise<T>): Promise<T> {
  const store = new FileCookieStore();
  let client: BandClient;
  try {
    client = await BandClient.create({ store });
  } catch (err) {
    if (err instanceof AuthError && process.stdin.isTTY) {
      await reprompt(store, err);
      client = await BandClient.create({ store });
    } else if (err instanceof AuthError) {
      fail(`auth failed: ${err.message}\n\n${COOKIE_INSTRUCTIONS}`);
    } else {
      throw err;
    }
  }

  try {
    return await fn(client);
  } catch (err) {
    if (err instanceof AuthError && process.stdin.isTTY) {
      await reprompt(store, err);
      return fn(await BandClient.create({ store }));
    }
    throw err;
  }
}

async function resolveGroup(
  client: BandClient,
  band: number,
  groupId: number | undefined,
  me: number | undefined,
): Promise<number[] | undefined> {
  if (!groupId) return undefined;
  const data = await client.getGroupMembers(band, groupId);
  return membersOf(data)
    .map((m) => m.user_no)
    .filter((u) => u && u !== me);
}

async function loadConfig(): Promise<Config> {
  const path = process.env.BAND_CONFIG ?? join(homedir(), ".band_config.json");
  try {
    return JSON.parse(await readFile(path, "utf8")) as Config;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return {};
    return fail(`${path}: ${e.message}`);
  }
}

// ---- commands ----

async function cmdLogin(values: Values): Promise<void> {
  const store = new FileCookieStore();
  let raw = str(values.session);
  if (!raw) {
    console.error(COOKIE_INSTRUCTIONS);
    openBrowser("https://www.band.us/");
    raw = await promptCookie();
  }
  if (!raw) fail("aborted");
  await saveCookies(store, raw);
  const client = await BandClient.create({ store });
  const names = client.cookieNames();
  console.log(
    `ok — saved ${names.length} cookies; secretKey present: ${names.includes("secretKey")}.`,
  );
}

async function cmdCalendars(values: Values, _pos: string[], config: Config): Promise<void> {
  const band = requireBand(values, config);
  console.log(JSON.stringify(await run((c) => c.getCalendars(band)), null, 2));
}

async function cmdMembers(values: Values, _pos: string[], config: Config): Promise<void> {
  const band = requireBand(values, config);
  const group = num(values.group);
  const data = await run((c) => (group ? c.getGroupMembers(band, group) : c.getMembers(band)));
  if (values.short) {
    for (const m of membersOf(data)) {
      console.log(`${String(m.user_no).padStart(12)}  ${m.name ?? ""}`);
    }
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
}

async function cmdGroups(values: Values, _pos: string[], config: Config): Promise<void> {
  const band = requireBand(values, config);
  const data = await run((c) => c.getMemberGroups(band));
  if (values.short) {
    for (const g of data.items ?? []) {
      const id = String(g.member_group_id).padStart(10);
      const count = String(g.member_count).padStart(4);
      console.log(`${id}  ${count}  ${g.name}`);
    }
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
}

async function cmdEvents(values: Values, _pos: string[], config: Config): Promise<void> {
  const band = requireBand(values, config);
  const cals = eventCalendars(num(values.calendar) ?? config.calendar);
  const { start, end } = dateWindow(str(values.start), str(values.end), 60);
  const data = await run((c) => c.getSchedules(band, start, end, { calendars: cals }));
  if (values.short) {
    for (const ev of data.items) {
      const d = parseIso(ev.start_at);
      const when = d ? localStamp(d) : (ev.start_at ?? "").slice(0, 16).replace("T", " ");
      console.log(`${when}  ${ev.name ?? ""}   [${ev.schedule_id ?? ""}]`);
    }
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
}

async function cmdSearch(values: Values, positionals: string[], config: Config): Promise<void> {
  const term = positionals[0];
  if (!term) fail("usage: bandstand search <term>");
  const band = requireBand(values, config);
  const days = num(values.days) ?? 365;
  await run(async (c) => {
    const calsData = await c.getCalendars(band);
    const calItems = calsData.internal_calendars ?? calsData.calendars ?? calsData.items ?? [];
    // The default calendar comes back without a calendar_id — flag it is_default:true;
    // pass {calendar_id, is_default:false} for the rest.
    const cals: CalendarRef[] = [];
    for (const cal of calItems) {
      if (cal.is_default) cals.push({ is_default: true });
      else if (cal.calendar_id != null)
        cals.push({ calendar_id: cal.calendar_id, is_default: false });
    }
    if (cals.length === 0) fail("no calendars returned for this band");

    const { start, end } = dateWindow(str(values.start), str(values.end), days);
    const data = await c.getSchedules(band, start, end, { calendars: cals });
    const needle = term.toLowerCase();
    const items = data.items
      .filter((e) => (e.name ?? "").toLowerCase().includes(needle))
      .sort((a, b) => (a.start_at ?? "").localeCompare(b.start_at ?? ""));

    if (values.json) {
      console.log(JSON.stringify(items, null, 2));
      return;
    }
    for (const ev of items) {
      const d = parseIso(ev.start_at);
      const when = d ? fmtLocal(d) : (ev.start_at ?? "").slice(0, 16).replace("T", " ");
      console.log(`${when} - ${scheduleUrl(ev)}   # ${ev.name ?? ""}`);
    }
  });
}

async function cmdWeek(values: Values, _pos: string[], config: Config): Promise<void> {
  const band = requireBand(values, config);
  const days = num(values.days) ?? 7;
  const cals = eventCalendars(num(values.calendar) ?? config.calendar);
  const { start, end } = dateWindow(undefined, undefined, days);
  const data = await run((c) => c.getSchedules(band, start, end, { calendars: cals }));
  const items = [...data.items].sort((a, b) => (a.start_at ?? "").localeCompare(b.start_at ?? ""));
  const cutoff = Date.now() + days * 86_400_000;
  for (const ev of items) {
    const d = parseIso(ev.start_at);
    if (!d) continue;
    if (d.getTime() > cutoff) break;
    console.log(`${fmtLocal(d)} - ${ev.name ?? ""} - ${scheduleUrl(ev)}`);
  }
}

function buildScheduleFromFlags(values: Values, config: Config): Schedule {
  const name = str(values.name);
  const start = str(values.start);
  const end = str(values.end);
  if (!name || !start || !end) fail("--file OR (--name --start --end) required");
  const sched: Schedule = {
    name,
    description: str(values.desc) ?? "",
    start_at: start,
    end_at: end,
    is_all_day: false,
    is_lunar: false,
    is_secret: Boolean(values.secret),
    schedule_time_zone_id: str(values.tz) ?? "America/Los_Angeles",
    photos: [],
    files: [],
    dropbox_files: [],
    external_files: [],
    alarms: [{ duration_type: "day", amount: 1 }],
    rsvp: {
      is_child_member_addible: false,
      custom_states: [],
      rsvp_visible_qualification: "all",
      recurring_rsvp_end_offset: null,
      is_maybe_enabled: false,
    },
    is_local_meetup: false,
  };
  const calendar = num(values.calendar) ?? config.calendar;
  if (calendar) sched.calendar = { calendar_id: calendar, is_default: false };
  const share = parseUserList(str(values.share));
  if (share.length > 0) sched.secret_sharers = share.map((u) => ({ user_no: u }));
  return sched;
}

async function cmdCreate(values: Values, _pos: string[], config: Config): Promise<void> {
  const band = requireBand(values, config);
  const file = str(values.file);
  let sched: Schedule;
  if (file) {
    sched = stripForCreate(JSON.parse(await readFile(file, "utf8")) as Schedule);
  } else {
    sched = buildScheduleFromFlags(values, config);
  }
  await run(async (c) => {
    const groupUserNos = await resolveGroup(c, band, num(values.group), config.me);
    applySharerFlags(sched, {
      groupUserNos,
      addUserNos: parseUserList(str(values["add-user"])),
      removeUserNos: parseUserList(str(values["remove-user"])),
      me: config.me ?? null,
    });
    const result = await c.createSchedule(band, sched, { announceable: Boolean(values.announce) });
    console.log(`created: ${result.schedule?.schedule_id ?? "?"}`);
    console.log(JSON.stringify(result, null, 2));
  });
}

async function cmdCopy(values: Values, positionals: string[], config: Config): Promise<void> {
  const scheduleId = positionals[0];
  if (!scheduleId) fail("usage: bandstand copy <schedule_id>");
  const band = requireBand(values, config);
  await run(async (c) => {
    const sched = stripForCreate(await c.getSchedule(band, scheduleId));
    const overrides: Array<[keyof Schedule, string | undefined]> = [
      ["name", str(values.name)],
      ["description", str(values.desc)],
      ["start_at", str(values.start)],
      ["end_at", str(values.end)],
      ["schedule_time_zone_id", str(values.tz)],
    ];
    for (const [key, value] of overrides) if (value !== undefined) sched[key] = value;
    const calendar = num(values.calendar);
    if (calendar) sched.calendar = { calendar_id: calendar, is_default: false };

    const groupUserNos = await resolveGroup(c, band, num(values.group), config.me);
    applySharerFlags(sched, {
      groupUserNos,
      addUserNos: parseUserList(str(values["add-user"])),
      removeUserNos: parseUserList(str(values["remove-user"])),
      me: config.me ?? null,
    });

    if (values["dry-run"]) {
      console.log(JSON.stringify(sched, null, 2));
      return;
    }
    const result = await c.createSchedule(band, sched, { announceable: Boolean(values.announce) });
    const sharers = sched.secret_sharers?.length ?? 0;
    console.log(
      `created: ${result.schedule?.schedule_id ?? "?"}  (is_secret=${Boolean(sched.is_secret)}, sharers=${sharers})`,
    );
  });
}

async function cmdDelete(values: Values, positionals: string[], config: Config): Promise<void> {
  const scheduleId = positionals[0];
  if (!scheduleId) fail("usage: bandstand delete <schedule_id>");
  const band = requireBand(values, config);
  await run(async (c) => {
    const res = await c.deleteSchedule(band, scheduleId, { notify: Boolean(values.notify) });
    console.log(`deleted: ${scheduleId}${res.message ? `  (${res.message})` : ""}`);
  });
}

async function cmdSyncGroup(values: Values, _pos: string[], config: Config): Promise<void> {
  const band = requireBand(values, config);
  const calendar = num(values.calendar) ?? config.calendar;
  if (calendar === undefined) fail('--calendar <id> required (or set "calendar" in config)');
  const groupId = num(values.group);
  if (!groupId) fail("--group <member_group_id> required");
  const days = num(values.days) ?? 120;

  await run(async (c) => {
    const groupData = await c.getGroupMembers(band, groupId);
    const groupNames = new Map<number, string>();
    for (const m of membersOf(groupData)) {
      if (m.user_no) groupNames.set(m.user_no, m.name ?? "");
    }
    if (groupNames.size === 0) fail(`group ${groupId} has no members (or wrong id)`);
    if (config.me) groupNames.delete(config.me);
    const gids = new Set(groupNames.keys());
    console.log(`group ${groupId}: ${gids.size} members`);

    const { start, end } = dateWindow(str(values.start), str(values.end), days);
    const data = await c.getSchedules(band, start, end, {
      calendars: [{ is_default: false, calendar_id: calendar }],
    });

    // Dedupe recurring series by schedule_no (3rd "/"-segment); update_schedule with
    // recurring_edit_type=ALL hits every occurrence of a series in one call.
    const seen = new Map<string, Schedule>();
    for (const ev of data.items) {
      const parts = (ev.schedule_id ?? "").split("/");
      if (parts.length < 3) continue;
      const key = parts[2] as string;
      if (!seen.has(key)) seen.set(key, ev);
    }
    console.log(
      `found ${seen.size} unique events in calendar ${calendar} between ${start} and ${end}`,
    );

    const updates: Array<{ full: Schedule; missing: number[] }> = [];
    for (const preview of seen.values()) {
      const full = await c.getSchedule(band, preview.schedule_id ?? "");
      if (!full.is_secret) {
        console.log(`  skip (public): ${preview.schedule_id}  ${(full.name ?? "").slice(0, 60)}`);
        continue;
      }
      const sharers = new Set(
        (full.secret_sharers ?? []).map((s) => s.user_no).filter((u): u is number => Boolean(u)),
      );
      const missing = [...gids].filter((u) => !sharers.has(u)).sort((a, b) => a - b);
      if (missing.length === 0) continue;
      updates.push({ full, missing });
      const names = missing
        .slice(0, 3)
        .map((u) => groupNames.get(u) ?? String(u))
        .join(", ");
      const more = missing.length > 3 ? ` +${missing.length - 3} more` : "";
      const when = (full.start_at ?? "").slice(0, 10);
      const title = (full.name ?? "").slice(0, 50).padEnd(50);
      console.log(`  +${String(missing.length).padStart(2)}  ${when}  ${title}  (${names}${more})`);
    }

    console.log(`\n${updates.length} events need updates.`);
    if (!values.apply) {
      console.log("(dry-run; pass --apply to write)");
      return;
    }
    for (const { full, missing } of updates) {
      const sched = stripForCreate(full);
      const merged = new Set((sched.secret_sharers ?? []).map((s) => s.user_no));
      for (const u of missing) merged.add(u);
      sched.secret_sharers = [...merged].sort((a, b) => a - b).map((u) => ({ user_no: u }));
      sched.is_secret = true;
      const sid = full.schedule_id ?? "";
      await c.updateSchedule(band, sid, sched, {
        notify: Boolean(values.notify),
        recurringEditType: "ALL",
      });
      console.log(`  updated ${sid}  (+${missing.length})`);
    }
  });
}

// ---- registry / dispatch ----

const COMMANDS: Record<string, Command> = {
  login: {
    summary: "save BAND cookies (interactive if --session omitted)",
    options: { session: { type: "string" } },
    run: (v) => cmdLogin(v),
  },
  calendars: {
    summary: "list calendars on a band",
    options: { band: { type: "string" } },
    run: cmdCalendars,
  },
  members: {
    summary: "list band members (or a member_group with --group)",
    options: { band: { type: "string" }, group: { type: "string" }, short: { type: "boolean" } },
    run: cmdMembers,
  },
  groups: {
    summary: "list member_groups (subgroups)",
    options: { band: { type: "string" }, short: { type: "boolean" } },
    run: cmdGroups,
  },
  events: {
    summary: "list schedules in a date window",
    options: {
      band: { type: "string" },
      start: { type: "string" },
      end: { type: "string" },
      calendar: { type: "string" },
      short: { type: "boolean" },
    },
    run: cmdEvents,
  },
  search: {
    summary: "search event titles across every calendar",
    usage:
      "bandstand search <term> [--band N] [--start YYYYMMDD] [--end YYYYMMDD] [--days N] [--json]",
    allowPositionals: true,
    options: {
      band: { type: "string" },
      start: { type: "string" },
      end: { type: "string" },
      days: { type: "string" },
      json: { type: "boolean" },
    },
    run: cmdSearch,
  },
  week: {
    summary: "list the coming week's events as 'Monday 3/11 @ 4pm - <link>'",
    options: { band: { type: "string" }, calendar: { type: "string" }, days: { type: "string" } },
    run: cmdWeek,
  },
  create: {
    summary: "create a schedule from --file or --name/--start/--end",
    options: {
      band: { type: "string" },
      file: { type: "string" },
      name: { type: "string" },
      desc: { type: "string" },
      start: { type: "string" },
      end: { type: "string" },
      tz: { type: "string" },
      calendar: { type: "string" },
      secret: { type: "boolean" },
      share: { type: "string" },
      group: { type: "string" },
      "add-user": { type: "string" },
      "remove-user": { type: "string" },
      announce: { type: "boolean" },
    },
    run: cmdCreate,
  },
  copy: {
    summary: "clone an existing schedule; override fields as needed",
    usage: "bandstand copy <schedule_id> [--name ...] [--start ...] [--group N] [--dry-run]",
    allowPositionals: true,
    options: {
      band: { type: "string" },
      name: { type: "string" },
      desc: { type: "string" },
      start: { type: "string" },
      end: { type: "string" },
      tz: { type: "string" },
      calendar: { type: "string" },
      group: { type: "string" },
      "add-user": { type: "string" },
      "remove-user": { type: "string" },
      announce: { type: "boolean" },
      "dry-run": { type: "boolean" },
    },
    run: cmdCopy,
  },
  delete: {
    summary: "delete a schedule (whole recurring series with --repeat ALL)",
    usage: "bandstand delete <schedule_id> --band N [--notify]",
    allowPositionals: true,
    options: { band: { type: "string" }, notify: { type: "boolean" } },
    run: cmdDelete,
  },
  "sync-group": {
    summary: "add a member_group's current roster to every secret event on a calendar",
    options: {
      band: { type: "string" },
      calendar: { type: "string" },
      group: { type: "string" },
      start: { type: "string" },
      end: { type: "string" },
      days: { type: "string" },
      apply: { type: "boolean" },
      notify: { type: "boolean" },
    },
    run: cmdSyncGroup,
  },
};

function printHelp(): void {
  const lines = ["bandstand — unofficial CLI for BAND (band.us) calendars", "", "Commands:"];
  const width = Math.max(...Object.keys(COMMANDS).map((n) => n.length));
  for (const [name, cmd] of Object.entries(COMMANDS)) {
    lines.push(`  ${name.padEnd(width)}  ${cmd.summary}`);
  }
  lines.push("", "Run `bandstand <command>` (alias `bs`); usage is shown on bad input.");
  console.log(lines.join("\n"));
}

function parse(command: Command, args: string[]) {
  try {
    return parseArgs({
      args,
      options: command.options,
      allowPositionals: command.allowPositionals ?? false,
      strict: true,
    });
  } catch (err) {
    const usage = command.usage ? `\n${command.usage}` : "";
    return fail(`${(err as Error).message}${usage}`);
  }
}

async function main(): Promise<void> {
  const [, , cmdName, ...rest] = process.argv;
  if (!cmdName || cmdName === "-h" || cmdName === "--help") {
    printHelp();
    process.exit(cmdName ? 0 : 1);
  }
  const command = COMMANDS[cmdName];
  if (!command)
    fail(`unknown command: ${cmdName}\n\nRun \`bandstand --help\` for the command list.`);

  const parsed = parse(command, rest);
  const config = await loadConfig();
  await command.run(parsed.values as Values, parsed.positionals, config);
}

main().catch((err) => {
  if (err instanceof AuthError) {
    fail(`\n[auth] ${err.message}\n\n${COOKIE_INSTRUCTIONS}`);
  }
  if (err instanceof BandApiError) {
    fail(`error: ${err.message}`);
  }
  fail(err instanceof Error ? (err.stack ?? err.message) : String(err));
});
