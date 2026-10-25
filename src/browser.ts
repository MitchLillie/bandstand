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
//
// band.us's own pages renew the session in the browser. An expired session
// surfaces as `SessionExpiredError`.

export { BandClient } from "./client";
export type { BandClientOptions } from "./client";
export { AuthError, BandApiError, SessionExpiredError } from "./errors";
export {
  type Classification,
  classifyError,
  type FailureKind,
  jwtExp,
  resultCodeOf,
  type SessionInfo,
  sessionInfo,
} from "./diagnostics";
export {
  type CookieJar,
  extractSecret,
  isJwtSession,
  mergeSetCookies,
  parseCookieHeader,
  serializeCookieHeader,
  sessionExpiresAt,
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
export { type RsvpSummary, rsvpSummary } from "./rsvp";
export { type Gap, mapLimit, Pacer, type PacerOptions, type Release } from "./pacing";
export {
  COOKIE_INSTRUCTIONS,
  DEFAULT_AKEY,
  DEFAULT_API_BASE,
  DEFAULT_JITTER_MS,
  DEFAULT_MAX_IN_FLIGHT,
  DEFAULT_READ_JITTER_MS,
  SESSION_EXPIRED_HINT,
} from "./constants";
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
  MyBandSchedulesResult,
  Paging,
  RecurringEditType,
  Rsvp,
  RsvpMember,
  RsvpState,
  Schedule,
  ScheduleLocation,
  ScheduleOwner,
  SchedulesPage,
  SecretSharer,
  SetRsvpResult,
} from "./types";
