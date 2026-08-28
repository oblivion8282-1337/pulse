/**
 * Reine Rechnung: welche Geraete muss eine Direktnachricht erreichen —
 * importfrei, damit Nodes eingebauter Testlaeufer sie ohne Bundler prueft
 * (s. CLAUDE.md „Die Falle").
 *
 * Verschickt wird an Geraete, nicht an Personen (Spec §2): jedes Geraet des
 * Empfaengers UND jedes EIGENE ANDERE Geraet — das eigene AKTUELLE Geraet
 * nicht, es hat den Klartext schon und eine Sitzung mit sich selbst gibt es
 * nicht. Ohne die eigenen anderen Geraete sieht z. B. der eigene Desktop nie,
 * was vom Handy geschrieben wurde.
 *
 * **Koexistenz-Regel (Spec §3, Bughunt 2026-08-28 FIX 1):** verschluesselt
 * wird nur, wenn BEIDE Konten mindestens ein DAUERHAFTES Geraet haben
 * (Electron- oder Android-App) — nicht schon, wenn irgendein Buendel
 * existiert. Grund ist Haltbarkeit, nicht Krypto-Faehigkeit: ein Browser kann
 * verschluesseln, aber nichts verlaesslich behalten, und es gibt kein
 * serverseitiges Backup. Ein Konto ganz ohne dauerhaftes Geraet bliebe sonst
 * unwiderbringlich ohne jede Kopie seines eigenen Verlaufs.
 */

/** Wire-Form eines Buendel-Eintrags aus `POST /keys/claim`
 *  (`GeraeteSchluesselOut` im Backend, `keysApi.claim` im Klienten). */
export type GeraeteBuendelEintrag = {
  device_pubkey: string;
  curve25519: string;
  signatur: string;
  einmalschluessel: string | null;
  rueckfallschluessel: string | null;
  /** Ob DIESES Geraet dauerhaft ist (Electron- oder Android-App, s.
   *  `veroeffentlichen.ts`) — Voraussetzung fuer die Koexistenz-Regel. Fehlt
   *  das Feld (Backend kennt es noch nicht), gilt das Geraet als NICHT
   *  dauerhaft — fail closed, s. Modulkopf. */
  dauerhaft?: boolean;
};

/** Ob mindestens EIN Geraet der Liste dauerhaft ist — die Koexistenz-Regel
 *  haengt am KONTO, nicht am einzelnen Geraet. */
function kontoHatDauerhaftesGeraet(geraete: GeraeteBuendelEintrag[]): boolean {
  return geraete.some((g) => g.dauerhaft === true);
}

/** Ein Zielgeraet mitsamt dem Konto, dem es gehoert. Der Umschlag wird ueber
 *  den `device_pubkey` adressiert, nicht ueber das Konto — welchem Konto ein
 *  Geraet gehoert, schlaegt der Server beim Einliefern selbst im Verzeichnis
 *  nach (`routes/postfach.py`, `empfaenger_user_id`). Das Konto steht hier
 *  trotzdem dabei: es unterscheidet „Geraet der Gegenstelle" von „eigenes
 *  anderes Geraet", und genau diese Unterscheidung prueft der Test. */
export type Zielgeraet = { userId: string; geraet: GeraeteBuendelEintrag };

/**
 * Berechnet die Zielgeraete einer Direktnachricht aus der Antwort von
 * `POST /keys/claim` (ein Eintrag je angefragtem Konto, ggf. leer).
 *
 * Ein Konto ganz ohne Geraete (Empfaenger ODER man selbst) liefert dafuer
 * schlicht keine Eintraege — das ist der Normalfall der Koexistenz-Regel
 * (Spec §3), kein Fehler. Ergibt die Gesamtrechnung KEIN Zielgeraet (weder
 * beim Empfaenger noch bei einem selbst), ist das dem Aufrufer zu ueberlassen:
 * er faellt dann auf den heutigen Klartext-Weg zurueck.
 *
 * **Bevor ueberhaupt gefaechert wird, greift die Koexistenz-Regel** (Spec §3,
 * Bughunt 2026-08-28 FIX 1): fehlt einem der beiden Konten ein dauerhaftes
 * Geraet, ist das Ergebnis eine leere Liste — genau wie „kein Buendel" —,
 * auch wenn beide Seiten Geraete veroeffentlicht haben. `eigenesGeraetDauerhaft`
 * ist das AKTUELLE Geraet des Absenders; es steht nie in `buendelJeKonto`
 * (das eigene aktuelle Geraet wird beim Faechern ausgeschlossen, s. u.), muss
 * die Dauerhaftigkeit seines Kontos also selbst mit hereinbringen.
 */
export function zielgeraeteBerechnen(
  buendelJeKonto: Record<string, GeraeteBuendelEintrag[]>,
  eigeneUserId: string,
  empfaengerUserId: string,
  eigenerGeraetePubkey: string,
  eigenesGeraetDauerhaft: boolean
): Zielgeraet[] {
  const empfaengerGeraete = buendelJeKonto[empfaengerUserId] ?? [];
  const eigeneGeraete = buendelJeKonto[eigeneUserId] ?? [];

  const eigenesKontoDauerhaft =
    eigenesGeraetDauerhaft || kontoHatDauerhaftesGeraet(eigeneGeraete);
  if (!eigenesKontoDauerhaft || !kontoHatDauerhaftesGeraet(empfaengerGeraete)) {
    return [];
  }

  const ziel: Zielgeraet[] = [];
  for (const geraet of empfaengerGeraete) {
    ziel.push({ userId: empfaengerUserId, geraet });
  }
  for (const geraet of eigeneGeraete) {
    if (geraet.device_pubkey === eigenerGeraetePubkey) continue;
    ziel.push({ userId: eigeneUserId, geraet });
  }
  return ziel;
}
