import { describe, expect, it } from "vitest";
import { dateWindow, parseIso, scheduleUrl, toApiTimestamp, yyyymmdd } from "../src/format";

describe("parseIso", () => {
  it("parses offsets written without a colon", () => {
    expect(parseIso("2026-05-01T18:30:00-0700")?.toISOString()).toBe("2026-05-02T01:30:00.000Z");
  });
  it("parses a trailing Z", () => {
    expect(parseIso("2026-05-01T00:00:00Z")?.toISOString()).toBe("2026-05-01T00:00:00.000Z");
  });
  it("returns null on junk or empty", () => {
    expect(parseIso("not a date")).toBeNull();
    expect(parseIso("")).toBeNull();
    expect(parseIso(undefined)).toBeNull();
  });
});

describe("dateWindow", () => {
  it("defaults to [today, today + days]", () => {
    const today = new Date(2026, 0, 1, 12, 0, 0);
    expect(dateWindow(undefined, undefined, 7, today)).toEqual({
      start: "20260101",
      end: "20260108",
    });
  });
  it("honors explicit start/end", () => {
    expect(dateWindow("20260301", "20260401", 7)).toEqual({ start: "20260301", end: "20260401" });
  });
});

describe("scheduleUrl", () => {
  it("url-encodes the schedule_id", () => {
    expect(scheduleUrl({ band_no: 5, schedule_id: "4/5/6/7" })).toBe(
      "https://band.us/band/5/schedule/4%2F5%2F6%2F7",
    );
  });
});

describe("yyyymmdd", () => {
  it("zero-pads month and day", () => {
    expect(yyyymmdd(new Date(2026, 2, 9))).toBe("20260309");
  });
});

describe("toApiTimestamp", () => {
  it("normalizes offsets (with or without a colon) to UTC Z form", () => {
    expect(toApiTimestamp("2026-05-01T18:30:00-0700")).toBe("2026-05-02T01:30:00Z");
    expect(toApiTimestamp("2026-05-01T18:30:00-07:00")).toBe("2026-05-02T01:30:00Z");
    expect(toApiTimestamp("2026-10-24T17:00:00Z")).toBe("2026-10-24T17:00:00Z");
  });

  it("treats offset-less input as local time", () => {
    expect(toApiTimestamp("2026-05-01T18:30")).toBe(
      new Date(2026, 4, 1, 18, 30).toISOString().replace(/\.\d{3}Z$/, "Z"),
    );
  });

  it("returns null for garbage", () => {
    expect(toApiTimestamp("next tuesday")).toBeNull();
  });
});
