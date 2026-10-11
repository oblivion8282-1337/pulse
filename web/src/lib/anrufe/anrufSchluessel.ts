/**
 * Der Anruf-Schlüssel (E2EE-Anrufe, 2026-09-09): 32 Zufallsbytes, base64 auf
 * der Leitung und an der Brücke zur Hülle, rohe Bytes für `livekit-client`.
 *
 * Aus `anruf.svelte.ts` herausgelöst (Grössen-Policy) — seit Etappe 4 lesen
 * ihn zwei Medienwege, und die Prüfung „sauber dekodierbar, genau 32 Bytes"
 * soll an EINER Stelle stehen. Importfrei (CLAUDE.md, `pnpm test:unit`).
 */

/** Frischer Anruf-Schlüssel: 32 Zufallsbytes, base64. */
export function neuAnrufSchluessel(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binär = '';
  for (const b of bytes) binär += String.fromCharCode(b);
  return btoa(binär);
}

/** base64 → ArrayBuffer (für `keyProvider.setKey`). Wirft bei kaputtem
 *  base64. */
export function base64ZuBytes(wert: string): ArrayBuffer {
  const binär = atob(wert);
  const bytes = new Uint8Array(binär.length);
  for (let i = 0; i < binär.length; i++) bytes[i] = binär.charCodeAt(i);
  return bytes.buffer;
}

/** Ist das ein brauchbarer Anruf-Schlüssel? Fail-closed: alles, was nicht
 *  sauber auf genau 32 Bytes dekodiert, wird verworfen, statt einen halben
 *  Schlüssel an LiveKit zu reichen. */
export function istAnrufSchluessel(wert: string): boolean {
  if (wert === '') return false;
  try {
    return base64ZuBytes(wert).byteLength === 32;
  } catch {
    return false;
  }
}
