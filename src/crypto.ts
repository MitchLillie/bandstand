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

/** Import a `secretKey` value as an HMAC-SHA256 signing key (Web Crypto). */
export function importHmacKey(
  secret: string,
  crypto: Crypto = globalThis.crypto,
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
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
