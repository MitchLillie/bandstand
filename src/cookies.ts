export type CookieJar = Record<string, string>;

/** Parse a `document.cookie` string (or a bare `band_session` value) into a jar. */
export function parseCookieHeader(input: string): CookieJar {
  const trimmed = input.trim().replace(/^['"]+|['"]+$/g, "");
  if (!trimmed.includes("=")) {
    return trimmed ? { band_session: trimmed } : {};
  }
  const jar: CookieJar = {};
  for (const part of trimmed.split(";")) {
    const segment = part.trim();
    const eq = segment.indexOf("=");
    if (eq === -1) continue;
    const name = segment.slice(0, eq).trim();
    const value = segment.slice(eq + 1).trim();
    if (name) jar[name] = value;
  }
  return jar;
}

/**
 * Build a `Cookie` request header from the jar.
 *
 * `secretKey` is intentionally excluded: in the browser it is path-scoped to
 * `/s/login/`, so it is never sent to the API host. We use it only as the HMAC
 * key (see {@link extractSecret}), not as a cookie.
 */
export function serializeCookieHeader(jar: CookieJar): string {
  return Object.entries(jar)
    .filter(([name]) => name !== "secretKey")
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

/** Merge `Set-Cookie` response headers into the jar. Returns true if anything changed. */
export function mergeSetCookies(jar: CookieJar, setCookies: readonly string[]): boolean {
  let changed = false;
  for (const raw of setCookies) {
    const firstPair = raw.split(";", 1)[0] ?? "";
    const eq = firstPair.indexOf("=");
    if (eq === -1) continue;
    const name = firstPair.slice(0, eq).trim();
    const value = firstPair.slice(eq + 1).trim();
    if (name && jar[name] !== value) {
      jar[name] = value;
      changed = true;
    }
  }
  return changed;
}

/** The `secretKey` cookie value with BAND's wrapping quotes stripped, if present. */
export function extractSecret(jar: CookieJar): string | undefined {
  const raw = jar.secretKey;
  return raw === undefined ? undefined : raw.replace(/^"+|"+$/g, "");
}
