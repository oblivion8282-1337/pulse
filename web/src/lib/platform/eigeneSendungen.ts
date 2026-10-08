/**
 * Wie viele Nachrichten dieser Nutzer auf DIESEM Gerät gesendet hat.
 *
 * Eine Zahl, zwei Verbraucher: die Bewertungsfrage (`bewertung.ts`, ab 20) und
 * die Vorerklärung zu Mitteilungen (`berechtigung.svelte.ts`, ab 3). Beide
 * wollen dasselbe wissen — „kennt dieser Mensch die App schon?" —, und zwei
 * Zähler auf dasselbe Ereignis wären zwei Wahrheiten, von denen eine irgendwann
 * nicht mitgezählt wird.
 *
 * Der Stand muss weder genau noch geräteübergreifend sein. Er soll nur
 * verhindern, dass ein frischer Nutzer gefragt wird; ein verlorener Zähler
 * verschiebt die Frage nach hinten, und das ist die harmlose Richtung.
 */

const SCHLUESSEL = 'pulse.sendungen';

export function sendungenLesen(): number {
  try {
    const roh = window.localStorage.getItem(SCHLUESSEL);
    const n = roh === null ? 0 : Number.parseInt(roh, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    // Kein oder abgeschalteter Speicher (privates Fenster) — von vorn.
    return 0;
  }
}

/** Erhöht den Stand und gibt den neuen zurück. */
export function sendungZaehlen(): number {
  const neu = sendungenLesen() + 1;
  try {
    window.localStorage.setItem(SCHLUESSEL, String(neu));
  } catch {
    /* Speicher voll oder abgeschaltet — dann eben nicht. */
  }
  return neu;
}
