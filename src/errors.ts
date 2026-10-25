import { SESSION_EXPIRED_HINT } from "./constants";

/** Raised when `band_session` / `secretKey` is missing, expired, or rejected. */
export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

/**
 * The session has expired (its `exp` passed, or BAND said so). Subclasses {@link AuthError}, so existing `instanceof AuthError` checks
 * still catch it; the fix is always a fresh login.
 */
export class SessionExpiredError extends AuthError {
  constructor(message: string) {
    super(message);
    this.name = "SessionExpiredError";
  }
}

/**
 * The CLI's one-screen message for an auth failure: a short "run: bandstand login"
 * instead of the DevTools copy-paste walkthrough (`bandstand login` still shows that).
 */
export function authFailureMessage(err: AuthError): string {
  if (err instanceof SessionExpiredError) return SESSION_EXPIRED_HINT;
  return `[auth] ${err.message}\nRun: bandstand login`;
}

/** Raised when BAND returns a non-success `result_code` (or a non-2xx status). */
export class BandApiError extends Error {
  readonly resultCode: number | undefined;
  readonly response: unknown;

  constructor(message: string, resultCode?: number, response?: unknown) {
    super(message);
    this.name = "BandApiError";
    this.resultCode = resultCode;
    this.response = response;
  }
}
