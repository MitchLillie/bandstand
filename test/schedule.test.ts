import { describe, expect, it } from "vitest";
import { applySharerFlags, parseUserList, stripForCreate } from "../src/schedule";
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
