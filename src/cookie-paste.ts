import type { CookieJar } from "./cookies";

/**
 * The cookies a browser-native BAND session carries. `band_session` and `secretKey`
 * are load-bearing (see {@link REQUIRED_COOKIES}); the rest are what a real browser
 * sends alongside them, and including them keeps our traffic looking ordinary.
 */
export const EXPECTED_COOKIES = [
  "band_session",
  "secretKey",
  "ai",
  "as",
  "rt",
  "SESSION",
  "JSESSIONID",
  "BBC",
  "di",
] as const;

/** The session token and the HMAC key. Without both, every API call 401s. */
export const REQUIRED_COOKIES = ["band_session", "secretKey"] as const;

/** RFC 6265 cookie-name token. Anything else on a line is junk, not a cookie. */
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** …and a real name has something to say, which rules out separators like `--`. */
const ALPHANUMERIC = /[0-9A-Za-z]/;

/** A lone line shaped like a session token — the "just the value" paste. */
const BARE_TOKEN = /^[A-Za-z0-9._~+/=%-]+$/;

/** `-H 'cookie: …'` / `--header "Cookie: …"`, including bash's `$'…'` quoting. */
const CURL_COOKIE_HEADER = /(?:-H|--header)\s+\$?(['"])\s*cookie\s*:\s*([\s\S]*?)\1/i;

/** `-b '…'` / `--cookie …`, quoted or bare. */
const CURL_COOKIE_FLAG = /(?:^|\s)(?:-b|--cookie)\s+\$?(?:(['"])([\s\S]*?)\1|([^\s'"][^\s]*))/i;

const CURL_COMMAND = /(?:^|\s)curl(?:\.exe)?\s/i;

/** What a parsed paste contains, in names only — never values. */
export interface CookieReport {
  /** Every cookie name recognized in the paste, in paste order. */
  names: string[];
  /** Expected cookies present with a non-empty value, in {@link EXPECTED_COOKIES} order. */
  present: string[];
  /** Expected cookies missing or empty. */
  missing: string[];
  /** The subset of {@link missing} the session cannot work without. */
  missingRequired: string[];
}

/**
 * Parse a pasted blob of cookies into a jar, auto-detecting the shape.
 *
 * Accepted formats — no flag, no mode, just paste:
 *
 * - `name=value; name=value` on one line (`document.cookie`), optionally quoted whole
 * - the DevTools **Application → Cookies** table, tab-separated, with or without its
 *   header row (columns are keyed off the header when present, since browsers differ
 *   on which columns they emit and in what order)
 * - one `name=value` per line
 * - one `name<TAB>value` per line
 * - JSON: an array of `{name, value, …}` (cookie-export extensions, CDP
 *   `Network.getAllCookies`), a `{cookies: […]}` wrapper, or a flat `{name: value}`
 * - a whole **Copy as cURL** command — the `Cookie` header is pulled out of it
 * - a bare token, treated as `band_session` (matches {@link parseCookieHeader})
 *
 * Values are kept verbatim, quotes included: BAND really does set `ai`, `as`, `rt`
 * and `secretKey` as quoted-string values, and the browser sends the quotes back.
 * Only {@link extractSecret} strips them, and only for the HMAC key.
 *
 * Junk — blank lines, the header row, unrelated cookies, trailing columns, a paste
 * that got cut off — is skipped rather than thrown on. Callers should check the
 * result with {@link inspectCookies}.
 */
export function parseCookieBlob(text: string): CookieJar {
  const trimmed = text.trim();
  if (!trimmed) return {};

  // A curl command is self-identifying: parse its Cookie header or nothing at all,
  // so the flags and URL around it can't be mistaken for a cookie table.
  if (CURL_COMMAND.test(trimmed) || CURL_COOKIE_HEADER.test(trimmed)) {
    const jar: CookieJar = {};
    addPairs(jar, extractCurlCookies(trimmed) ?? "");
    return jar;
  }

  const fromJson = parseJsonCookies(trimmed);
  if (fromJson !== undefined) return fromJson;

  // A one-line paste may be wrapped in shell quotes; a multi-line one never is.
  const single = !trimmed.includes("\n");
  return parseLines(single ? unwrapQuotes(trimmed) : trimmed);
}

/** Which of the {@link EXPECTED_COOKIES} a jar has. Names only — never values. */
export function inspectCookies(jar: CookieJar): CookieReport {
  const has = (name: string) => (jar[name] ?? "").trim() !== "";
  return {
    names: Object.keys(jar),
    present: EXPECTED_COOKIES.filter(has),
    missing: EXPECTED_COOKIES.filter((name) => !has(name)),
    missingRequired: REQUIRED_COOKIES.filter((name) => !has(name)),
  };
}

/**
 * One- or two-line summary of a jar for the user: counts and names, never values.
 * Cookie values are account credentials — they must not reach stdout, stderr or logs.
 */
export function formatCookieReport(jar: CookieJar): string {
  const { names, present, missing } = inspectCookies(jar);
  const found = `recognized ${names.length} cookie${names.length === 1 ? "" : "s"}`;
  const expected = `${present.length}/${EXPECTED_COOKIES.length} expected`;
  const lines = [
    present.length > 0
      ? `${found}; ${expected} present: ${present.join(", ")}`
      : `${found}; ${expected} present`,
  ];
  if (missing.length > 0) lines.push(`missing: ${missing.join(", ")}`);
  return lines.join("\n");
}

// ---- internals ----

/** Strip one matched pair of surrounding quotes (a shell copy of the whole paste). */
function unwrapQuotes(value: string): string {
  const first = value[0];
  if (value.length >= 2 && (first === '"' || first === "'") && value.endsWith(first)) {
    return value.slice(1, -1).trim();
  }
  return value;
}

function add(jar: CookieJar, rawName: string | undefined, rawValue: string | undefined): void {
  const name = (rawName ?? "").trim();
  if (!COOKIE_NAME.test(name) || !ALPHANUMERIC.test(name)) return;
  jar[name] = (rawValue ?? "").trim();
}

/** Add every `name=value` in a `;`- (or newline-) separated run. */
function addPairs(jar: CookieJar, text: string): void {
  for (const part of text.split(/[;\n]/)) {
    const segment = part.trim();
    const eq = segment.indexOf("=");
    if (eq > 0) add(jar, segment.slice(0, eq), segment.slice(eq + 1));
  }
}

/**
 * Split a table row into columns, or return null if the line isn't one.
 *
 * Tabs are what the DevTools table copies as. Editors and chat clients sometimes
 * turn them into runs of spaces, so fall back to that — but only for lines that
 * open with a bare cookie name and carry a third column, which is enough to keep
 * `a=1; b=2; c=3` (three space-separated pairs) out of the table path.
 */
function splitColumns(line: string): string[] | null {
  if (line.includes("\t")) return line.split("\t");
  const fields = line.trim().split(/\s+/);
  if (fields.length < 3) return null;
  return COOKIE_NAME.test(fields[0] ?? "") ? fields : null;
}

/** Locate the Name and Value columns in a header row, if this row is one. */
function headerColumns(columns: string[]): [number, number] | null {
  let name = -1;
  let value = -1;
  for (const [index, cell] of columns.entries()) {
    const label = cell.trim().toLowerCase();
    if (label === "name" && name === -1) name = index;
    else if (label === "value" && value === -1) value = index;
  }
  return name === -1 || value === -1 ? null : [name, value];
}

function parseLines(text: string): CookieJar {
  const jar: CookieJar = {};
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  let nameIndex = 0;
  let valueIndex = 1;

  for (const line of lines) {
    const columns = splitColumns(line);
    if (columns) {
      const header = headerColumns(columns);
      if (header) {
        [nameIndex, valueIndex] = header;
        continue;
      }
      add(jar, columns[nameIndex], columns[valueIndex]);
      continue;
    }
    if (line.includes("=")) {
      addPairs(jar, line);
      continue;
    }
    // A lone token with no separators anywhere: the legacy "just the session" paste.
    // Shape-checked so a stray fragment (truncated JSON, prose) isn't stored as one.
    if (lines.length === 1 && BARE_TOKEN.test(line.trim())) add(jar, "band_session", line);
  }
  return jar;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Case-insensitive scalar field lookup — exporters disagree on `name` vs `Name`. */
function field(record: Record<string, unknown>, key: string): string | undefined {
  for (const [k, v] of Object.entries(record)) {
    if (k.toLowerCase() !== key) continue;
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
  }
  return undefined;
}

function parseJsonCookies(text: string): CookieJar | undefined {
  const first = text[0];
  if (first !== "[" && first !== "{") return undefined;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return undefined; // not JSON after all — let the line parser have it
  }
  return jarFromJson(data);
}

function jarFromJson(data: unknown): CookieJar | undefined {
  const jar: CookieJar = {};

  if (Array.isArray(data)) {
    for (const entry of data) {
      if (!isRecord(entry)) continue;
      const name = field(entry, "name");
      if (name !== undefined) add(jar, name, field(entry, "value") ?? "");
    }
    return jar;
  }
  if (!isRecord(data)) return undefined;

  // Playwright storageState and several extensions wrap the array in an object.
  if (Array.isArray(data.cookies)) return jarFromJson(data.cookies);

  // A single cookie descriptor, rather than a flat {name: value} map.
  const name = field(data, "name");
  const value = field(data, "value");
  if (name !== undefined && value !== undefined) {
    add(jar, name, value);
    return jar;
  }

  for (const [key, entry] of Object.entries(data)) {
    if (typeof entry === "string" || typeof entry === "number") add(jar, key, String(entry));
  }
  return jar;
}

function extractCurlCookies(text: string): string | undefined {
  const header = CURL_COOKIE_HEADER.exec(text);
  if (header?.[2]?.includes("=")) return header[2];
  if (!CURL_COMMAND.test(text)) return undefined;
  // `-b` also takes a jar *filename*; only treat it as cookies if it looks like them.
  const flag = CURL_COOKIE_FLAG.exec(text);
  const value = flag?.[2] ?? flag?.[3];
  return value?.includes("=") ? value : undefined;
}
