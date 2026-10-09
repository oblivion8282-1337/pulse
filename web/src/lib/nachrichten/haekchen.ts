/**
 * Die Häkchen-Treppe als reine Rechnung (WhatsApp-Semantik):
 * Uhr = unterwegs, ein grauer Haken = gesendet, zwei graue = bei allen
 * angekommen, zwei blaue = von allen gelesen — dazu „nicht zugestellt“ für
 * eine Gruppennachricht, die niemand empfangen konnte.
 *
 * Importfrei (relative `.ts`-Importe), damit Nodes Testläufer sie prüft — die
 * Hülle, die die Stores liest, steht daneben (`haekchenAnzeige.ts`).
 *
 * **Alle Vergleiche laufen über Nachrichten-IDs, nie über Uhrzeiten.** Ein
 * Stand ist die kanonische ID der jüngsten gelesenen bzw. angekommenen
 * Nachricht (`stores/lesestandKern.ts::lesestandAnker`). Bis 2026-10-10 hing
 * „angekommen“ an der Empfangszeit des Ereignisses — wer beim Abholen offline
 * war, sah den Haken nie, und nach einem Neustart war er weg.
 */
import { compareSnowflakeId } from '../utils/snowflake.ts';

export type HaekchenStufe = 'uhr' | 'gesendet' | 'zugestellt' | 'gelesen' | 'nicht_zugestellt';

/** Hat `stand` die Nachricht `anker` erreicht? */
export function erreicht(stand: string | undefined, anker: string): boolean {
  return !!stand && compareSnowflakeId(stand, anker) >= 0;
}

export interface TreppenEingabe {
  /** Optimistische Kopie, die Sendung läuft noch. */
  vorlaeufig: boolean;
  /** Gruppennachricht, die kein Mitglied empfangen konnte (lokal verwahrt). */
  nichtZugestellt: boolean;
  /** Kanonische ID der eigenen Nachricht. */
  anker: string;
  /** Wer die Nachricht bekommen sollte (ohne einen selbst). */
  empfaenger: readonly string[];
  gelesen: (konto: string) => string | undefined;
  zugestellt: (konto: string) => string | undefined;
  /** Darf Blau erscheinen? In DMs nur bei eigenen eingeschalteten
   *  Lesebestätigungen (WhatsApp-Regel), in Gruppen immer. */
  blauErlaubt: boolean;
}

export function haekchenStufe(e: TreppenEingabe): HaekchenStufe {
  if (e.vorlaeufig) return 'uhr';
  if (e.nichtZugestellt) return 'nicht_zugestellt';
  if (e.empfaenger.length === 0) return 'gesendet';
  const alleGelesen = e.empfaenger.every((k) => erreicht(e.gelesen(k), e.anker));
  if (alleGelesen && e.blauErlaubt) return 'gelesen';
  // Gelesen schliesst angekommen ein — auch wenn Blau gerade nicht erlaubt ist
  // oder der Zustellstand (ältere Gegenstelle) fehlt.
  const alleAngekommen = e.empfaenger.every(
    (k) => erreicht(e.zugestellt(k), e.anker) || erreicht(e.gelesen(k), e.anker)
  );
  return alleAngekommen ? 'zugestellt' : 'gesendet';
}

/**
 * Wer eine Gruppennachricht bekommen sollte: die Mitglieder, die zur
 * Sendezeit schon drin waren. Gegen die HEUTIGE Liste gerechnet, wurde eine
 * längst gelesene Nachricht wieder grau, sobald jemand beitrat — der Neue
 * kann ältere Nachrichten gar nicht entschlüsseln (Megolm ab Beitritt).
 * Ein unlesbares Datum zählt mit (lieber zu streng als zu früh blau).
 */
export function empfaengerZurSendezeit(
  mitglieder: readonly { user_id: string; beigetreten_am: string }[],
  ich: string,
  gesendetAm: string
): string[] {
  const gesendet = Date.parse(gesendetAm);
  return mitglieder
    .filter((m) => m.user_id !== ich && !(Date.parse(m.beigetreten_am) > gesendet))
    .map((m) => m.user_id);
}

export type InfoStatus = 'gelesen' | 'zugestellt' | 'ausstehend';

/** Die Info-Ansicht einer eigenen Gruppennachricht: je Empfänger sein Stand,
 *  gelesen zuerst, dann angekommen, dann ausstehend (Reihenfolge sonst stabil). */
export function infoJeEmpfaenger(
  e: Pick<TreppenEingabe, 'anker' | 'empfaenger' | 'gelesen' | 'zugestellt'>
): { konto: string; status: InfoStatus }[] {
  const rang: Record<InfoStatus, number> = { gelesen: 0, zugestellt: 1, ausstehend: 2 };
  return e.empfaenger
    .map((konto) => {
      const status: InfoStatus = erreicht(e.gelesen(konto), e.anker)
        ? 'gelesen'
        : erreicht(e.zugestellt(konto), e.anker)
          ? 'zugestellt'
          : 'ausstehend';
      return { konto, status };
    })
    .sort((a, b) => rang[a.status] - rang[b.status]);
}
