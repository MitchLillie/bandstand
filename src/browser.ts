// Browser / edge-safe entry — identical to the main entry but WITHOUT the Node
// file-backed cookie store (which imports `node:fs`). Import this from browser
// extensions, service workers, Deno, Bun, and edge runtimes:
//
//   import { BandClient, MemoryCookieStore } from "bandstand/browser";
//
// In a browser the runtime owns the cookie jar, so construct with browser mode:
//
//   const client = await BandClient.create({
//     cookies: { secretKey },          // value read via chrome.cookies, etc.
//     sendCookieHeader: false,         // `Cookie` is forbidden in browsers
//     credentials: "include",          // let the runtime attach session cookies
//   });

export { BandClient } from "./client";
export type { BandClientOptions } from "./client";
export { AuthError, BandApiError } from "./errors";
export {
  type CookieJar,
  extractSecret,
  mergeSetCookies,
  parseCookieHeader,
  serializeCookieHeader,
} from "./cookies";
export { type CookieStore, MemoryCookieStore } from "./store";
export {
  applySharerFlags,
  normalizeSharers,
  parseUserList,
  type SharerOptions,
  stripForCreate,
} from "./schedule";
export { dateWindow, fmtLocal, parseIso, scheduleUrl, yyyymmdd } from "./format";
export { COOKIE_INSTRUCTIONS, DEFAULT_AKEY, DEFAULT_API_BASE } from "./constants";
export type {
  Alarm,
  BandApiResponse,
  Calendar,
  CalendarRef,
  CalendarsResult,
  CreateScheduleResult,
  DeleteScheduleResult,
  Member,
  MemberGroup,
  MemberGroupsResult,
  MembersResult,
  Paging,
  RecurringEditType,
  Rsvp,
  Schedule,
  ScheduleLocation,
  SchedulesPage,
  SecretSharer,
} from "./types";
