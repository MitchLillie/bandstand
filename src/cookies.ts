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

/**
 * Whether `band_session` is a JWT (`header.payload.signature`) rather than BAND's
 * legacy opaque token. JWT sessions sign with the base64url-decoded `secretKey`.
 */
export function isJwtSession(jar: CookieJar): boolean {
  return jar.band_session?.split(".").length === 3;
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const part = token.split(".")[1];
  if (!part) return undefined;
  try {
    const b64 = part.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "="));
    const json = new TextDecoder().decode(Uint8Array.from(binary, (ch) => ch.charCodeAt(0)));
    const payload: unknown = JSON.parse(json);
    return payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * When the session expires, in ms since the epoch — or `undefined` if unknown
 * (opaque token and no `ai` cookie). Mirrors `needTokenRenewal` in BandWebAuthModule:
 * the `ai` cookie (`<x>,<hex ms>`) wins when present, else the JWT's `exp` claim.
 */
export function sessionExpiresAt(jar: CookieJar): number | undefined {
  const ai = jar.ai?.split(",")[1];
  if (ai) {
    const ms = Number.parseInt(ai, 16);
    if (Number.isFinite(ms)) return ms;
  }
  if (!isJwtSession(jar)) return undefined;
  const exp = decodeJwtPayload(jar.band_session ?? "")?.exp;
  return typeof exp === "number" ? exp * 1000 : undefined;
}
