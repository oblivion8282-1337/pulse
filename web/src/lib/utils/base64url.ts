/**
 * base64url <-> bytes (RFC 4648 §5, padding-tolerant on decode, stripped on
 * encode). Used by the WebAuthn ceremonies, the cert-login nonce/signature
 * round-trip, and the web-push VAPID/key conversion — all of which speak the
 * same URL-safe, unpadded alphabet. One implementation, no dependency.
 */

/** Decode a base64url string into raw bytes. Missing padding is tolerated.
 *  Backed by a plain `ArrayBuffer` (not the `SharedArrayBuffer`-tolerant union)
 *  so the result is a `BufferSource` usable directly as a WebAuthn challenge or
 *  `applicationServerKey` without touching `.buffer`. */
export function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (value.length % 4)) % 4);
  const bin = atob((value + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Encode bytes as an unpadded base64url string. */
export function base64UrlEncode(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
