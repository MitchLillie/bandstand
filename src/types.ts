/** Envelope BAND wraps every API response in. `result_code === 1` means success. */
export interface BandApiResponse<T> {
  result_code: number;
  result_data: T;
  message?: string;
}

export interface Calendar {
  calendar_id?: number;
  is_default?: boolean;
  name?: string;
  [key: string]: unknown;
}

/** The reference shape BAND accepts inside a schedule payload. */
export interface CalendarRef {
  calendar_id?: number;
  is_default: boolean;
}

export interface Member {
  user_no: number;
  name: string;
  me?: boolean;
  role?: string;
  profile_image_url?: string;
  [key: string]: unknown;
}

export interface MemberGroup {
  member_group_id: number;
  member_count: number;
  name: string;
  [key: string]: unknown;
}

export interface SecretSharer {
  user_no: number;
  name?: string;
}

export type RsvpState = "ATTENDANCE" | "ABSENCE" | "MAYBE";

export interface RsvpMember {
  // BAND's rsvp response lists identify members by name/member_key, not user_no.
  user_no?: number;
  name?: string;
  member_key?: string;
  [key: string]: unknown;
}

export interface Rsvp {
  is_child_member_addible?: boolean;
  custom_states?: unknown[];
  rsvp_visible_qualification?: string;
  recurring_rsvp_end_offset?: number | null;
  is_maybe_enabled?: boolean;
  // Populated on a detailed get_schedule response:
  attendee_list?: RsvpMember[];
  absentee_list?: RsvpMember[];
  maybe_list?: RsvpMember[];
  pending_attendee_list?: RsvpMember[];
  attendee_count?: number;
  absentee_count?: number;
  maybe_count?: number;
  viewer_rsvp_state?: RsvpState;
  [key: string]: unknown;
}

export interface Alarm {
  duration_type: string;
  amount: number;
}

export interface ScheduleLocation {
  latitude?: number;
  longitude?: number;
  name?: string;
  address?: string;
  [key: string]: unknown;
}

export interface ScheduleOwner {
  user_no?: number;
  name?: string;
  [key: string]: unknown;
}

export interface Schedule {
  schedule_id?: string;
  band_no?: number;
  owner?: ScheduleOwner;
  name?: string;
  description?: string;
  calendar?: CalendarRef | Calendar;
  start_at?: string;
  end_at?: string;
  is_all_day?: boolean;
  is_lunar?: boolean;
  is_secret?: boolean;
  secret_sharers?: SecretSharer[];
  schedule_time_zone_id?: string;
  photos?: unknown[];
  files?: unknown[];
  dropbox_files?: unknown[];
  external_files?: unknown[];
  alarms?: Alarm[];
  rsvp?: Rsvp;
  is_local_meetup?: boolean;
  location?: ScheduleLocation;
  is_album_auto_created?: boolean;
  signups?: unknown[];
  /**
   * Read-only container BAND returns on `get_schedule`. Note that the event's
   * location comes back here as `location_v2` even though it is *written* as
   * `location` — see {@link scheduleLocation}.
   */
  attachment?: { location_v2?: ScheduleLocation; [key: string]: unknown };
  recurrence?: { freq?: string; since?: string; until?: string; [key: string]: unknown };
  [key: string]: unknown;
}

export interface Paging {
  previous_params?: string | Record<string, unknown> | null;
  next_params?: string | Record<string, unknown> | null;
}

export interface SchedulesPage {
  items: Schedule[];
  paging?: Paging;
}

export interface CalendarsResult {
  internal_calendars?: Calendar[];
  calendars?: Calendar[];
  items?: Calendar[];
}

export interface MembersResult {
  members?: Member[];
  items?: Member[];
}

export interface MemberGroupsResult {
  items: MemberGroup[];
  has_member_group?: boolean;
  everyone_mention_enabled?: boolean;
}

export interface CreateScheduleResult {
  schedule?: { schedule_id?: string; [key: string]: unknown };
}

/**
 * Scope of a recurring edit.
 *
 * BAND's 2026 calendar release renamed the single-occurrence value from `THIS`
 * to `ONE_ONLY`; `THIS` is now rejected by the server. It is kept here for
 * source compatibility and translated to `ONE_ONLY` on the way out.
 *
 * Note: only `ALL` and `ONE_ONLY` have been verified against the live API.
 */
export type RecurringEditType =
  | "ALL"
  | "ONE_ONLY"
  | "THIS_AND_FUTURE"
  /** @deprecated renamed to `ONE_ONLY`; still accepted and translated. */
  | "THIS";

export interface DeleteScheduleResult {
  message?: string;
}

export interface MyBandSchedulesResult {
  items?: Schedule[];
  schedules?: Schedule[];
}

export interface SetRsvpResult {
  [key: string]: unknown;
}
