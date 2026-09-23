/**
 * Die Wiedereinspiel-Entscheidung für Megolm-Gruppennachrichten (Bughunt
 * 2026-09-23) — importfrei, damit der Node-Testläufer sie ohne Bundler
 * prüft (CLAUDE.md „Die Falle“).
 *
 * **Der Angriff:** Megolm erlaubt das Entschlüsseln eines bereits gesehenen
 * Geheimtexts beliebig oft (`gruppe.rs::Gruppennachricht::zaehler` wird
 * herausgegeben, genau dafür). Der einzige Schutz war bislang
 * `verlaufSchonAbgelegt` über die vom SERVER vergebene Zustellungs-ID — ein
 * böswilliger Server legte denselben Geheimtext unter neuer ID erneut in
 * das Postfach und die Nachricht erschien (auch gelöschte wieder).
 *
 * **Die Regel:** je eingehender Sitzung wird der höchste sauber geöffnete
 * Zählerstand gemerkt (`gruppenSitzungen.ts`, neustartfest in IndexedDB).
 * Eine Nachricht mit Zähler ≤ Stand ist normalerweise ein Wiedereinspiel
 * und wird verworfen — AUSSER sie trägt dieselbe Zustellungs-ID wie der
 * Standeintrag: dann ist es die EIGENE Zustellung, die zwischen Ent-
 * schlüsseln und Ablegen nicht durchkam (Absturz; sie blieb unquittiert
 * liegen und kommt beim nächsten Zyklus wieder). Sie zu verwerfen wäre
 * Nachrichtenverlust, sie erneut zu öffnen ist gefahrlos — schon abgelegt
 * ist sie zu dem Zeitpunkt nicht (`zustellungOeffnen` prüft das zuerst),
 * und ein echter Wiedereinspiel unter fremder, neuer ID scheitert an genau
 * diesem Vergleich.
 *
 * **Bekannte Grenze (ponytail):** die Annahme „eine Sitzung sieht ihre
 * Nachrichten in Zählerreihenfolge“ beruht darauf, dass der Abholweg die
 * Postfach-Einträge aufsteigend nach Server-ID verarbeitet. Genau so kommt
 * sie vom Server; wer sie jemals ungeordnet verarbeitet, lässt diese
 * Entscheidung fallen und braucht eine „gesehene Zähler“-Menge statt des
 * Höchststands.
 */

export type Wasserstand = {
  zaehler: number;
  /** Die Zustellungs-ID, die diesen Stand erzeugt hat. */
  zustellung: string;
};

export type WasserstandEntscheidung =
  | 'ok' // noch nie gesehener Zählerstand — öffnen und Stand heben
  | 'eigene_wiederholung' // dieselbe Zustellung kommt erneut (Absturz-Fenster) — gefahrlos erneut öffnen
  | 'wiedereinspiel'; // älterer Stand unter NEUER Zustellungs-ID — Angriff, verwerfen

export function wasserstandEntscheidung(
  stand: Wasserstand | null,
  zaehler: number,
  zustellungId: string
): WasserstandEntscheidung {
  if (stand === null || zaehler > stand.zaehler) return 'ok';
  return zustellungId === stand.zustellung ? 'eigene_wiederholung' : 'wiedereinspiel';
}
