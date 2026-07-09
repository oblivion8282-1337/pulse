/**
 * Draht-Protokoll des Direktpfads — Spiegel von
 * `infra/self-host/direct-adapter/src/protocol.rs`. **Synchron halten.**
 *
 * DataChannel `http`: ein Kanal, viele Requests (multiplext über `id`).
 * DataChannel `ws:<pfad>`: ein Kanal = ein Backend-WebSocket, Frames 1:1.
 */

export interface ReqFrame {
  t: 'req';
  id: number;
  method: string;
  path: string;
  headers: [string, string][];
  fin: boolean;
}

export interface BodyFrame {
  t: 'body';
  id: number;
  b64: string;
  fin: boolean;
}

export interface ResFrame {
  t: 'res';
  id: number;
  status: number;
  headers: [string, string][];
  fin: boolean;
}

export interface ErrFrame {
  t: 'err';
  id: number;
  message: string;
}

export type FrameFromAdapter = ResFrame | BodyFrame | ErrFrame;

/** Base64 → Bytes (ohne Abhängigkeit; `atob` ist überall verfügbar). */
export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Bytes → Base64, in Blöcken (String.fromCharCode(...) sprengt bei großen
 *  Bodies den Argument-Stack). */
export function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** Liest die `a=fingerprint`-Zeile einer SDP (normalisiert auf Großschreibung).
 *  Das ist die Identität des Servers — Grundlage des TOFU-Pinnings. */
export function sdpFingerprint(sdp: string): string | null {
  const line = sdp.split('\n').find((l) => l.trim().startsWith('a=fingerprint:'));
  if (!line) return null;
  return line.trim().slice('a=fingerprint:'.length).trim().toUpperCase();
}
