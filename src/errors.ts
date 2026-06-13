/** Raised when `band_session` / `secretKey` is missing, expired, or rejected. */
export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
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
