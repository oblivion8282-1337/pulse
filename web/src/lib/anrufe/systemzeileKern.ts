/**
 * Ob ein beendetes 1:1-Telefonat eine Systemzeile im Chat hinterlässt — und
 * welche. Importfrei (Repo-Muster, s. `krypto/dmSendeSperre.ts`), damit der
 * Node-Testläufer sie prüfen kann.
 *
 * Zwei Regeln, die zusammen genau EINE Zeile je Anruf ergeben:
 *
 * * **Nur der Einleiter schreibt.** Beide Seiten erleben das Ende (der
 *   Auflegende lokal, die Gegenseite per `call_ende`) — schrieben beide,
 *   stünde die Zeile doppelt im gemeinsamen Verlauf. Der Einleiter ist die
 *   stabilere Wahl: beim E2EE-Weg trägt sein Client die verschlüsselte
 *   Nutzlast ohnehin über den Postfach-Pfad, die Zeile ist schlicht seine
 *   Nachricht.
 * * **Nur bei Ergebnis.** „Aufgelegt" ohne Dauer ist abgebrochenes Klingeln,
 *   ohne dass etwas zu dokumentieren wäre; jeder echte End-Grund des Servers
 *   (`verpasst`, `abgelehnt`) und jede echte Dauer zählt. Der Server rechnet
 *   die Dauer selbst (`routes/anrufe.py`, ab `verbunden_at`) — der lokale
 *   Ticker des Stores zählt dasselbe Intervall.
 */

export type AnrufZeilenSchluessel = 'verpasst' | 'abgelehnt' | 'dauer';

interface AnrufSystemzeile {
  schluessel: AnrufZeilenSchluessel;
  dauerSek: number;
}

export function anrufSystemzeile(
  art: string,
  rolle: string,
  grund: string,
  dauerSek: number
): AnrufSystemzeile | null {
  if (art !== 'dm' || rolle !== 'ausgehend') return null;
  if (grund === 'verpasst' || grund === 'abgelehnt') return { schluessel: grund, dauerSek: 0 };
  if (grund === 'aufgelegt' && dauerSek > 0) return { schluessel: 'dauer', dauerSek };
  return null;
}

/** Die Senke, die die Chat-Systemzeile sendet (`systemzeileSenden.ts`). */
export type ZeilenZiel = (
  kanalId: string,
  schluessel: AnrufZeilenSchluessel,
  dauerSek: number
) => void;

/**
 * Höchstens EINE Zeile je Anruf: `ende()` und der lokale Abbau im
 * Anruf-Zustand können sich im Wettlauf doppelt melden. Die Senke dockt der
 * WS-Bootstrap an — Injektion statt Import (`systemzeileSenden.ts`), sonst
 * zirkelt die Sendekette; ohne Senke (Tests, vor dem Bootstrap) bleibt es
 * beim Merken. Aus `anruf.svelte.ts` herausgelöst (Grössen-Policy).
 */
export class AnrufSystemzeilen {
  #ziel: ZeilenZiel | null = null;
  #erledigt = false;

  zielSetzen(ziel: ZeilenZiel): void {
    this.#ziel = ziel;
  }

  /** Ein neuer Anruf beginnt — er darf wieder eine Zeile hinterlassen. */
  neuerAnruf(): void {
    this.#erledigt = false;
  }

  /** Grund und Dauer sind bekannt → einmalig die Zeile anstossen, falls
   *  `anrufSystemzeile` eine vorsieht. */
  hinterlassen(
    anruf: { art: string; rolle: string; channel_id: string },
    grund: string,
    dauerSek: number
  ): void {
    if (this.#erledigt) return;
    const zeile = anrufSystemzeile(anruf.art, anruf.rolle, grund, dauerSek);
    if (!zeile) return;
    this.#erledigt = true;
    this.#ziel?.(anruf.channel_id, zeile.schluessel, zeile.dauerSek);
  }
}
