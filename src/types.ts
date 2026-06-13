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
}

export interface Rsvp {
  is_child_member_addible?: boolean;
  custom_states?: unknown[];
  rsvp_visible_qualification?: string;
  recurring_rsvp_end_offset?: number | null;
  is_maybe_enabled?: boolean;
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

export interface Schedule {
  schedule_id?: string;
  band_no?: number;
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

export type RecurringEditType = "ALL" | "THIS" | "THIS_AND_FUTURE";

export interface DeleteScheduleResult {
  message?: string;
}
