const encoder = new TextEncoder();

/**
 * The string BAND signs: the URL with `scheme://host` stripped (so it starts at
 * the path) and `'` percent-encoded. Mirrors `extractPath` in the web client's
 * BandWebAuthModule. Everything else is already percent-encoded by URLSearchParams
 * before this runs.
 */
export function extractPath(url: string): string {
  const noScheme = url.replace(/^.*?:\/\//, "");
  const path = noScheme.replace(/^[^/]+/, "");
  return path.replaceAll("'", "%27");
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64urlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const b64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "="));
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
}

/**
 * How the `secretKey` string becomes HMAC key bytes. BandWebAuthModule's `makeMd`
 * UTF-8-encodes it for legacy opaque sessions, but base64url-decodes it when the
 * session is a JWT (`isJwtType: true` in the getKey bootstrap).
 */
export type SecretEncoding = "utf8" | "base64url";

/** Import a `secretKey` value as an HMAC-SHA256 signing key (Web Crypto). */
export function importHmacKey(
  secret: string,
  crypto: Crypto = globalThis.crypto,
  encoding: SecretEncoding = "utf8",
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoding === "base64url" ? base64urlToBytes(secret) : encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

/** The `md` request header: base64(HMAC_SHA256(secret, extractPath(url))). */
export async function signPath(
  key: CryptoKey,
  url: string,
  crypto: Crypto = globalThis.crypto,
): Promise<string> {
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(extractPath(url)));
  return bytesToBase64(new Uint8Array(mac));
}
