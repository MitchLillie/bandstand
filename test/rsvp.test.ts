import { describe, expect, it } from "vitest";
import { rsvpSummary } from "../src/rsvp";
import type { Schedule } from "../src/types";

describe("rsvpSummary", () => {
  it("buckets responders and finds not-responded by name (lists lack user_no)", () => {
    const schedule: Schedule = {
      secret_sharers: [
        { user_no: 1, name: "Alice" },
        { user_no: 2, name: "Bob" },
        { user_no: 3, name: "Carol" },
      ],
      rsvp: {
        // Real BAND lists identify members by name/member_key, not user_no.
        attendee_list: [{ name: "Alice", member_key: "AAA" }],
        absentee_list: [{ name: "Bob", member_key: "BBB" }],
        maybe_list: [],
        pending_attendee_list: [],
        attendee_count: 1,
        absentee_count: 1,
        maybe_count: 0,
      },
    };
    const s = rsvpSummary(schedule);
    expect(s.going.map((m) => m.name)).toEqual(["Alice"]);
    expect(s.notGoing.map((m) => m.name)).toEqual(["Bob"]);
    expect(s.notResponded.map((m) => m.name)).toEqual(["Carol"]);
    expect(s.counts).toEqual({ going: 1, notGoing: 1, maybe: 0, invited: 3 });
  });

  it("handles a schedule with no rsvp", () => {
    expect(rsvpSummary({}).counts).toEqual({ going: 0, notGoing: 0, maybe: 0, invited: 0 });
  });
});
