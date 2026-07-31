import { describe, expect, it } from "vitest";
import { normalizeEditType } from "../src/client";
import {
  applySharerFlags,
  parseUserList,
  scheduleLocation,
  stripForCreate,
  stripForUpdate,
  toLocalOffsetIso,
} from "../src/schedule";
import type { Schedule } from "../src/types";

describe("stripForCreate", () => {
  it("keeps only writable fields and fills empty file lists", () => {
    const src: Schedule = {
      name: "Canvass",
      schedule_id: "4/1/2/3",
      owner: { user_no: 9 } as unknown as Schedule["owner"],
      comment_count: 5,
      calendar: { calendar_id: 11, is_default: false, name: "extra" },
    };
    const out = stripForCreate(src);
    expect(out.name).toBe("Canvass");
    expect(out.schedule_id).toBeUndefined();
    expect(out).not.toHaveProperty("comment_count");
    expect(out.calendar).toEqual({ calendar_id: 11, is_default: false });
    expect(out.photos).toEqual([]);
    expect(out.files).toEqual([]);
  });

  it("normalizes rsvp to the writable subset and drops malformed sharers", () => {
    const out = stripForCreate({
      rsvp: { is_maybe_enabled: true, server_only_field: 1 },
      secret_sharers: [{ user_no: 1 }, { name: "no id" } as never, { user_no: 2 }],
    });
    expect(out.rsvp).toEqual({ is_maybe_enabled: true, recurring_rsvp_end_offset: null });
    expect(out.secret_sharers).toEqual([{ user_no: 1 }, { user_no: 2 }]);
  });
});

describe("applySharerFlags", () => {
  it("replaces with group roster minus me and forces is_secret", () => {
    const sched: Schedule = {};
    applySharerFlags(sched, { groupUserNos: [1, 2, 3], me: 2 });
    expect(sched.secret_sharers).toEqual([{ user_no: 1 }, { user_no: 3 }]);
    expect(sched.is_secret).toBe(true);
  });

  it("adds and removes without duplicating", () => {
    const sched: Schedule = { secret_sharers: [{ user_no: 1 }] };
    applySharerFlags(sched, { addUserNos: [1, 2], removeUserNos: [3] });
    expect(sched.secret_sharers).toEqual([{ user_no: 1 }, { user_no: 2 }]);
  });

  it("leaves is_secret untouched when nothing changes", () => {
    const sched: Schedule = { is_secret: false };
    applySharerFlags(sched, {});
    expect(sched.is_secret).toBe(false);
  });
});

describe("parseUserList", () => {
  it("parses and trims", () => {
    expect(parseUserList(" 1, 2 ,3")).toEqual([1, 2, 3]);
  });
  it("returns [] for empty/undefined", () => {
    expect(parseUserList(undefined)).toEqual([]);
    expect(parseUserList("")).toEqual([]);
  });
  it("throws on non-numeric input", () => {
    expect(() => parseUserList("1,abc")).toThrow();
  });
});

describe("toLocalOffsetIso", () => {
  it("renders a UTC instant as local time with an offset", () => {
    // get_schedule returns UTC; update_schedule wants local + offset.
    expect(toLocalOffsetIso("2026-08-08T18:00:00Z", "America/Denver")).toBe(
      "2026-08-08T12:00:00-0600",
    );
    // An evening event: the UTC date is the NEXT day, the local date is not.
    expect(toLocalOffsetIso("2026-09-23T02:00:00Z", "America/Denver")).toBe(
      "2026-09-22T20:00:00-0600",
    );
    // Standard time, so a different offset for the same zone.
    expect(toLocalOffsetIso("2026-11-18T03:00:00Z", "America/Denver")).toBe(
      "2026-11-17T20:00:00-0700",
    );
  });
});

describe("scheduleLocation", () => {
  it("finds a venue returned under attachment.location_v2", () => {
    expect(
      scheduleLocation({ attachment: { location_v2: { name: "Butterfield Park Pavilion" } } }),
    ).toEqual({ name: "Butterfield Park Pavilion" });
  });

  it("prefers a top-level location and keeps its coordinates", () => {
    const pinned = { latitude: 40.49, longitude: -112.03, name: "X", address: "Y" };
    expect(scheduleLocation({ location: pinned })).toEqual(pinned);
  });

  it("returns undefined when there is no venue", () => {
    expect(scheduleLocation({})).toBeUndefined();
    expect(scheduleLocation({ attachment: {} })).toBeUndefined();
  });
});

describe("stripForUpdate", () => {
  const base: Schedule = {
    name: "Rehearsal",
    schedule_id: "4/1/2/3",
    comment_count: 5,
    start_at: "2026-08-08T18:00:00Z",
    end_at: "2026-08-08T20:00:00Z",
    schedule_time_zone_id: "America/Denver",
    calendar: { is_default: true },
  };

  it("converts timestamps into local time with an offset", () => {
    const out = stripForUpdate(base);
    expect(out.start_at).toBe("2026-08-08T12:00:00-0600");
    expect(out.end_at).toBe("2026-08-08T14:00:00-0600");
  });

  it("sends calendar_id explicitly as null on the default calendar", () => {
    const out = stripForUpdate(base);
    expect(out.calendar).toEqual({ calendar_id: null, is_default: true });
    expect(Object.keys(out.calendar as object)).toContain("calendar_id");
  });

  it("includes the fields the update endpoint requires", () => {
    const out = stripForUpdate(base);
    for (const key of ["is_album_auto_created", "is_secret", "alarms", "signups"]) {
      expect(out).toHaveProperty(key);
    }
    expect(out.schedule_id).toBeUndefined();
    expect(out).not.toHaveProperty("comment_count");
  });

  it("carries a venue across even though it is read from attachment", () => {
    // Regression: update_schedule replaces the whole object, so dropping this
    // erases the event's location with no error.
    const out = stripForUpdate({
      ...base,
      attachment: { location_v2: { name: "Butterfield Park Pavilion" } },
    });
    expect(out.location).toEqual({ name: "Butterfield Park Pavilion" });
  });

  it("does not blank existing photos, files or sharers", () => {
    const out = stripForUpdate({
      ...base,
      photos: [{ photo_key: "abc" }],
      files: [{ file_id: 9 }],
      secret_sharers: [{ user_no: 7 }],
    });
    expect(out.photos).toEqual([{ photo_key: "abc" }]);
    expect(out.files).toEqual([{ file_id: 9 }]);
    expect(out.secret_sharers).toEqual([{ user_no: 7 }]);
  });

  it("omits location and sharers entirely when the event has none", () => {
    const out = stripForUpdate(base);
    expect(out).not.toHaveProperty("location");
    expect(out).not.toHaveProperty("secret_sharers");
    expect(out.photos).toEqual([]);
  });
});

describe("normalizeEditType", () => {
  it("translates the legacy THIS value to ONE_ONLY", () => {
    expect(normalizeEditType("THIS")).toBe("ONE_ONLY");
  });

  it("passes through current values and defaults to ALL", () => {
    expect(normalizeEditType("ONE_ONLY")).toBe("ONE_ONLY");
    expect(normalizeEditType("ALL")).toBe("ALL");
    expect(normalizeEditType(undefined)).toBe("ALL");
  });
});
