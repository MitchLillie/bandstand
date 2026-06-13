/** `YYYYMMDD` in local time — the date format BAND's schedule endpoints expect. */
export function yyyymmdd(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

/** Resolve a [start, end] `YYYYMMDD` window, defaulting to [today, today + days]. */
export function dateWindow(
  start: string | undefined,
  end: string | undefined,
  days: number,
  today: Date = new Date(),
): { start: string; end: string } {
  return {
    start: start ?? yyyymmdd(today),
    end: end ?? yyyymmdd(new Date(today.getTime() + days * 86_400_000)),
  };
}

/**
 * Parse a BAND timestamp into a Date, tolerating `Z` and offsets written without a
 * colon (e.g. `-0700`), which the spec-strict `Date` constructor rejects. Returns
 * null on anything unparseable.
 */
export function parseIso(raw: string | undefined | null): Date | null {
  if (!raw) return null;
  const normalized = raw.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** `Monday 3/11 @ 4pm` (or `4:30pm` when minutes are non-zero), in local time. */
export function fmtLocal(date: Date): string {
  const day = date.toLocaleDateString("en-US", { weekday: "long" });
  const md = `${date.getMonth() + 1}/${date.getDate()}`;
  const hour = date.getHours() % 12 || 12;
  const ampm = date.getHours() < 12 ? "am" : "pm";
  const minutes = date.getMinutes();
  const time =
    minutes === 0 ? `${hour}${ampm}` : `${hour}:${String(minutes).padStart(2, "0")}${ampm}`;
  return `${day} ${md} @ ${time}`;
}

/** Web URL for a schedule: `https://band.us/band/<band_no>/schedule/<schedule_id>`. */
export function scheduleUrl(ev: { band_no?: number; schedule_id?: string }): string {
  const sid = encodeURIComponent(ev.schedule_id ?? "");
  return `https://band.us/band/${ev.band_no ?? ""}/schedule/${sid}`;
}
