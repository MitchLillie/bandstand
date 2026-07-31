import type { CalendarRef, Rsvp, Schedule, ScheduleLocation, SecretSharer } from "./types";

/** Fields BAND's `create_schedule` accepts; everything else is rejected as an extra. */
const WRITABLE_SCHEDULE_FIELDS = new Set<string>([
  "name",
  "description",
  "calendar",
  "start_at",
  "end_at",
  "is_all_day",
  "is_lunar",
  "is_secret",
  "secret_sharers",
  "schedule_time_zone_id",
  "photos",
  "files",
  "dropbox_files",
  "external_files",
  "alarms",
  "rsvp",
  "is_local_meetup",
  "location",
]);

/** The browser's `create_schedule` rsvp payload; the server rejects extras. */
const WRITABLE_RSVP_FIELDS = new Set<string>([
  "is_child_member_addible",
  "custom_states",
  "rsvp_visible_qualification",
  "recurring_rsvp_end_offset",
  "is_maybe_enabled",
]);

const EMPTY_LIST_FIELDS = ["photos", "files", "dropbox_files", "external_files"] as const;

/**
 * Reduce a `get_schedule` response to the subset `create_schedule` /
 * `update_schedule` will accept, so a schedule can be cloned or re-posted.
 */
export function stripForCreate(src: Schedule): Schedule {
  const out: Schedule = {};
  for (const [key, value] of Object.entries(src)) {
    if (WRITABLE_SCHEDULE_FIELDS.has(key)) out[key] = value;
  }
  for (const field of EMPTY_LIST_FIELDS) {
    if (out[field] === undefined) out[field] = [];
  }

  const cal = out.calendar;
  if (cal && typeof cal === "object") {
    const ref: CalendarRef = {
      calendar_id: (cal as { calendar_id?: number }).calendar_id,
      is_default: Boolean((cal as { is_default?: unknown }).is_default),
    };
    out.calendar = ref;
  }

  const rsvp = out.rsvp;
  if (rsvp && typeof rsvp === "object") {
    const cleaned: Rsvp = {};
    for (const [key, value] of Object.entries(rsvp)) {
      if (WRITABLE_RSVP_FIELDS.has(key)) cleaned[key] = value;
    }
    if (cleaned.recurring_rsvp_end_offset === undefined) cleaned.recurring_rsvp_end_offset = null;
    out.rsvp = cleaned;
  }

  if (Array.isArray(out.secret_sharers)) {
    out.secret_sharers = normalizeSharers(out.secret_sharers);
  }
  return out;
}

/**
 * The event's location, wherever BAND is currently keeping it.
 *
 * `update_schedule` accepts the venue as `location`, but `get_schedule` returns
 * it nested under `attachment.location_v2`. Reading only `location` therefore
 * finds nothing on most events, and a fetch-modify-write round trip silently
 * drops the venue.
 */
export function scheduleLocation(src: Schedule): ScheduleLocation | undefined {
  return src.location ?? src.attachment?.location_v2 ?? undefined;
}

/**
 * Format an instant as local time with a UTC offset, e.g.
 * `2026-08-08T12:00:00-0600`.
 *
 * `get_schedule` returns timestamps in UTC, but `update_schedule` expects them
 * in the event's own zone with an offset. Posting the UTC value straight back
 * shifts evening events onto the following day.
 */
export function toLocalOffsetIso(instant: string | number | Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      timeZoneName: "longOffset",
    })
      .formatToParts(new Date(instant))
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const offset = (parts.timeZoneName ?? "GMT+00:00").replace("GMT", "").replace(":", "") || "+0000";
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
}

/**
 * Reduce a `get_schedule` response to what `update_schedule` accepts.
 *
 * Distinct from {@link stripForCreate}: the update endpoint wants local-offset
 * timestamps, an explicit `calendar_id` (null when default), and the
 * `is_album_auto_created` / `is_secret` / `alarms` / `signups` quartet.
 *
 * `update_schedule` REPLACES the whole schedule object, so every field omitted
 * here is deleted server-side. Anything present on the source that the user can
 * set — location, photos, files, alarms, sign-ups, RSVP, secret sharers — is
 * carried through untouched rather than rebuilt, so nothing is silently lost.
 *
 * @param timeZoneId overrides the event's own `schedule_time_zone_id`.
 */
export function stripForUpdate(src: Schedule, timeZoneId?: string): Schedule {
  const tz = timeZoneId ?? src.schedule_time_zone_id ?? "UTC";
  const out: Schedule = {
    name: src.name,
    is_local_meetup: Boolean(src.is_local_meetup),
    is_album_auto_created: Boolean(src.is_album_auto_created),
    description: src.description ?? "",
    calendar: {
      calendar_id: (src.calendar as CalendarRef | undefined)?.calendar_id ?? null,
      is_default: Boolean((src.calendar as CalendarRef | undefined)?.is_default),
    } as CalendarRef,
    is_all_day: Boolean(src.is_all_day),
    is_lunar: Boolean(src.is_lunar),
    is_secret: Boolean(src.is_secret),
    schedule_time_zone_id: tz,
    photos: [],
    files: [],
    dropbox_files: [],
    external_files: [],
    alarms: src.alarms ?? [],
    signups: src.signups ?? [],
  };

  if (src.start_at) out.start_at = toLocalOffsetIso(src.start_at, tz);
  if (src.end_at) out.end_at = toLocalOffsetIso(src.end_at, tz);

  const location = scheduleLocation(src);
  if (location) out.location = location;
  if (src.rsvp) out.rsvp = src.rsvp;
  if (Array.isArray(src.secret_sharers) && src.secret_sharers.length > 0) {
    out.secret_sharers = normalizeSharers(src.secret_sharers);
  }
  for (const field of EMPTY_LIST_FIELDS) {
    const value = src[field];
    if (Array.isArray(value) && value.length > 0) out[field] = value;
  }
  return out;
}

/** Keep only well-formed `{ user_no }` entries — guards against malformed input. */
export function normalizeSharers(sharers: readonly unknown[]): SecretSharer[] {
  const out: SecretSharer[] = [];
  for (const s of sharers) {
    const userNo = (s as { user_no?: unknown })?.user_no;
    if (typeof userNo === "number") out.push({ user_no: userNo });
  }
  return out;
}

export interface SharerOptions {
  /** Replace the sharer list with this roster (minus `me`). */
  groupUserNos?: number[];
  addUserNos?: number[];
  removeUserNos?: number[];
  /** The caller's own `user_no` — BAND rejects the owner as their own sharer. */
  me?: number | null;
}

/**
 * Mutate `schedule.secret_sharers` per the given options. `groupUserNos` replaces
 * the list; add/remove then tweak it. Forces `is_secret = true` when anything changes.
 */
export function applySharerFlags(schedule: Schedule, opts: SharerOptions): void {
  const me = opts.me ?? null;
  let touched = false;

  if (opts.groupUserNos) {
    schedule.secret_sharers = opts.groupUserNos
      .filter((u) => u !== me)
      .map((u) => ({ user_no: u }));
    touched = true;
  }

  const sharers = normalizeSharers(schedule.secret_sharers ?? []);
  const present = new Set(sharers.map((s) => s.user_no));
  for (const u of opts.addUserNos ?? []) {
    if (u === me || present.has(u)) continue;
    sharers.push({ user_no: u });
    present.add(u);
    touched = true;
  }

  const remove = new Set(opts.removeUserNos ?? []);
  let result = sharers;
  if (remove.size > 0) {
    result = sharers.filter((s) => !remove.has(s.user_no));
    touched = true;
  }

  if (touched) {
    schedule.secret_sharers = result;
    schedule.is_secret = true;
  }
}

/** Parse a `"1, 2, 3"` user-list string into numbers, ignoring blanks. */
export function parseUserList(input: string | null | undefined): number[] {
  if (!input) return [];
  const out: number[] = [];
  for (const piece of input.split(",")) {
    const trimmed = piece.trim();
    if (!trimmed) continue;
    const n = Number(trimmed);
    if (!Number.isInteger(n)) throw new RangeError(`not a user_no: ${trimmed}`);
    out.push(n);
  }
  return out;
}
