// Failure classification + secret-free session introspection, used by the live
// smoke test (`npm run smoke`) and handy for any consumer that wants to tell a user
// *why* a call failed. Browser-safe: no Node imports.

import { type CookieJar, extractSecret, isJwtSession } from "./cookies";
import { AuthError, BandApiError } from "./errors";

/** What a session jar looks like, without revealing any cookie values. */
export interface SessionInfo {
  hasBandSession: boolean;
  hasSecretKey: boolean;
  /** `band_session` has the `header.payload.signature` shape. */
  isJwt: boolean;
  /** JWT `exp` claim (seconds since epoch), when decodable. */
  jwtExp?: number;
  /** `jwtExp` as an ISO timestamp. */
  jwtExpIso?: string;
  /** Whether `jwtExp` is in the past at `now`. Undefined for opaque sessions. */
  jwtExpired?: boolean;
  /** Seconds until (positive) or since (negative) expiry. */
  jwtExpiresInSec?: number;
}

function decodeBase64url(value: string): string {
  const b64 = value.replaceAll("-", "+").replaceAll("_", "/");
  return atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "="));
}

/** Read only the numeric `exp` claim from a JWT. Never returns other claims. */
export function jwtExp(token: string): number | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const exp = (JSON.parse(decodeBase64url(payload)) as { exp?: unknown }).exp;
    return typeof exp === "number" && Number.isFinite(exp) ? exp : undefined;
  } catch {
    return undefined;
  }
}

/** Describe a cookie jar's session shape and JWT expiry. Contains no secrets. */
export function sessionInfo(jar: CookieJar, now: number = Date.now()): SessionInfo {
  const info: SessionInfo = {
    hasBandSession: Boolean(jar.band_session),
    hasSecretKey: Boolean(extractSecret(jar)),
    isJwt: isJwtSession(jar),
  };
  if (info.isJwt && jar.band_session) {
    const exp = jwtExp(jar.band_session);
    if (exp !== undefined) {
      info.jwtExp = exp;
      info.jwtExpIso = new Date(exp * 1000).toISOString();
      info.jwtExpiresInSec = Math.round(exp - now / 1000);
      info.jwtExpired = info.jwtExpiresInSec <= 0;
    }
  }
  return info;
}

export type FailureKind =
  /** No jar / no band_session / no secretKey. */
  | "session-missing"
  /** JWT `exp` is in the past (server will reject). */
  | "session-expired"
  /** secretKey can't be decoded into an HMAC key. */
  | "session-invalid"
  /** result_code 300 or HTTP 401/403: signature mismatch or rejected session. */
  | "auth"
  /** result_code 251 / 200 "Temporary error": usually a missing/invalid param. */
  | "params"
  /** Any other non-success result_code or non-2xx status. */
  | "api"
  /** DNS / connect / TLS / timeout. */
  | "network"
  | "unknown";

export interface Classification {
  kind: FailureKind;
  resultCode?: number;
  /** One-line human explanation + what to do. */
  hint: string;
}

const LOGIN_HINT = "run `bandstand login` to save a fresh session";

/** Pull a `result_code` out of an error (BandApiError field, or AuthError's JSON blob). */
export function resultCodeOf(err: unknown): number | undefined {
  if (err instanceof BandApiError && err.resultCode !== undefined) return err.resultCode;
  const message = err instanceof Error ? err.message : String(err);
  const match = /"result_code"\s*:\s*(\d+)/.exec(message) ?? /result_code=(\d+)/.exec(message);
  return match?.[1] ? Number(match[1]) : undefined;
}

const NETWORK_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "CERT_HAS_EXPIRED",
]);

function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "AbortError" || err.name === "TimeoutError") return true;
  const cause = (err as { cause?: { code?: string; name?: string } }).cause;
  if (cause?.code && NETWORK_CODES.has(cause.code)) return true;
  if (cause?.name === "ConnectTimeoutError") return true;
  return err instanceof TypeError && /fetch failed|network/i.test(err.message);
}

/**
 * Bucket a failure from {@link BandClient} into something actionable. Pass the
 * jar's {@link SessionInfo} so a 300 on an expired JWT reads as "expired" rather
 * than "signing broke".
 */
export function classifyError(err: unknown, session?: SessionInfo): Classification {
  if (isNetworkError(err)) {
    const cause = (err as { cause?: { code?: string } }).cause?.code;
    return {
      kind: "network",
      hint: `network failure${cause ? ` (${cause})` : ""} — check connectivity / DNS to api-usw.band.us`,
    };
  }

  const message = err instanceof Error ? err.message : String(err);

  if (err instanceof AuthError && /^no (band_session|secretKey|session file)/.test(message)) {
    return { kind: "session-missing", hint: `${message.split(" — ")[0]} — ${LOGIN_HINT}` };
  }

  // atob / importKey failures while turning secretKey into an HMAC key.
  if (
    err instanceof Error &&
    (err.name === "InvalidCharacterError" || /importKey|base64|atob/i.test(message))
  ) {
    return {
      kind: "session-invalid",
      hint: `secretKey could not be decoded into an HMAC key (${err.name}) — ${LOGIN_HINT}`,
    };
  }

  const resultCode = resultCodeOf(err);
  const httpAuth = /^HTTP (401|403)\b/.test(message);

  if (resultCode === 300 || httpAuth) {
    if (session?.jwtExpired) {
      return {
        kind: "session-expired",
        resultCode,
        hint: `session JWT expired at ${session.jwtExpIso} — ${LOGIN_HINT}`,
      };
    }
    const signing = session?.isJwt
      ? "JWT session: md = base64(HMAC-SHA256(base64url-decoded secretKey, path))"
      : "opaque session: md = base64(HMAC-SHA256(utf8 secretKey, path))";
    return {
      kind: "auth",
      resultCode,
      hint:
        `${httpAuth ? message : "result_code 300 (not authorized)"}: signature or session rejected. ` +
        `Either the session is dead/stale (${LOGIN_HINT}) or signing no longer matches the web ` +
        `client (${signing}) — check whether BAND changed makeMd in BandWebAuthModule.js.`,
    };
  }

  if (resultCode === 251 || resultCode === 200) {
    return {
      kind: "params",
      resultCode,
      hint: `result_code ${resultCode} "Temporary error": signing passed but a param is missing or invalid — compare the request against a HAR of the web client.`,
    };
  }

  if (err instanceof BandApiError || resultCode !== undefined) {
    return {
      kind: "api",
      resultCode,
      hint: `BAND API error${resultCode !== undefined ? ` (result_code ${resultCode})` : ""}: ${message.slice(0, 160)}`,
    };
  }

  if (err instanceof AuthError) {
    return { kind: "auth", hint: `${message.slice(0, 160)} — ${LOGIN_HINT}` };
  }

  return { kind: "unknown", hint: message.slice(0, 200) };
}
