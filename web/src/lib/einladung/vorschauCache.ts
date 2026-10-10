// Kleiner In-Speicher-Cache für die Cloud-Vorschau der Chat-Einladungskarte.
//
// Die Nachrichtenliste ist virtualisiert: jede Karte entsteht beim
// Wiederauftauchen neu und lädt ihre Vorschau erneut — viele Karten könnten so
// die Bremse (120/min) selbst auslösen. Gemerkt werden nur ERFOLGE und
// Ablehnungen, die der Aufrufer als dauerhaft einstuft (404); Bremse (429) und
// Netzfehler nie, sonst bliebe ein flüchtiger Fehler 60 s lang haften.
// Runenfrei und importfrei (läuft unter Nodes Läufer).

export const VORSCHAU_TTL_MS = 60_000;

interface Eintrag<T> {
  zeit: number;
  ergebnis: Promise<T>;
}

export function erzeugeVorschauCache<T>(
  istDauerhaft: (fehler: unknown) => boolean,
  jetzt: () => number = Date.now,
  ttlMs: number = VORSCHAU_TTL_MS
) {
  const eintraege = new Map<string, Eintrag<T>>();

  return {
    // Gleichzeitige Aufrufe teilen sich denselben laufenden Abruf.
    holen(code: string, laden: () => Promise<T>): Promise<T> {
      const t = jetzt();
      const vorhanden = eintraege.get(code);
      if (vorhanden && t - vorhanden.zeit < ttlMs) return vorhanden.ergebnis;
      const ergebnis = laden();
      const eintrag = { zeit: t, ergebnis };
      eintraege.set(code, eintrag);
      ergebnis.catch((e: unknown) => {
        if (!istDauerhaft(e) && eintraege.get(code) === eintrag) eintraege.delete(code);
      });
      return ergebnis;
    },
    leeren(): void {
      eintraege.clear();
    }
  };
}
