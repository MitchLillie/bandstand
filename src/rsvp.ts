import type { RsvpMember, Schedule } from "./types";

export interface RsvpSummary {
  going: RsvpMember[];
  notGoing: RsvpMember[];
  maybe: RsvpMember[];
  pending: RsvpMember[];
  /** Invited (secret_sharers) who haven't responded in any list. */
  notResponded: RsvpMember[];
  counts: { going: number; notGoing: number; maybe: number; invited: number };
}

/**
 * Summarize who's coming from a detailed `get_schedule` response. `notResponded`
 * is the invite list (`secret_sharers`) minus anyone who appears in a response list,
 * matched by `user_no`.
 */
export function rsvpSummary(schedule: Schedule): RsvpSummary {
  const r = schedule.rsvp ?? {};
  const going = r.attendee_list ?? [];
  const notGoing = r.absentee_list ?? [];
  const maybe = r.maybe_list ?? [];
  const pending = r.pending_attendee_list ?? [];

  // Response lists carry `name` (+ member_key) but not user_no, so match the invite
  // list (secret_sharers) against responders by name — same approach the web app uses.
  const respondedNames = new Set(
    [...going, ...notGoing, ...maybe, ...pending].map((m) => m.name).filter(Boolean),
  );
  const invited = (schedule.secret_sharers ?? []).filter((s) => s.user_no);
  const notResponded: RsvpMember[] = invited
    .filter((s) => s.name && !respondedNames.has(s.name))
    .map((s) => ({ user_no: s.user_no, name: s.name }));

  return {
    going,
    notGoing,
    maybe,
    pending,
    notResponded,
    counts: {
      going: r.attendee_count ?? going.length,
      notGoing: r.absentee_count ?? notGoing.length,
      maybe: r.maybe_count ?? maybe.length,
      invited: invited.length,
    },
  };
}
