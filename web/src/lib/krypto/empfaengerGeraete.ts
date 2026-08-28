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
 */

/** Wire-Form eines Buendel-Eintrags aus `POST /keys/claim`
 *  (`GeraeteSchluesselOut` im Backend, `keysApi.claim` im Klienten). */
export type GeraeteBuendelEintrag = {
  device_pubkey: string;
  curve25519: string;
  signatur: string;
  einmalschluessel: string | null;
  rueckfallschluessel: string | null;
};

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
 */
export function zielgeraeteBerechnen(
  buendelJeKonto: Record<string, GeraeteBuendelEintrag[]>,
  eigeneUserId: string,
  empfaengerUserId: string,
  eigenerGeraetePubkey: string
): Zielgeraet[] {
  const ziel: Zielgeraet[] = [];
  for (const geraet of buendelJeKonto[empfaengerUserId] ?? []) {
    ziel.push({ userId: empfaengerUserId, geraet });
  }
  for (const geraet of buendelJeKonto[eigeneUserId] ?? []) {
    if (geraet.device_pubkey === eigenerGeraetePubkey) continue;
    ziel.push({ userId: eigeneUserId, geraet });
  }
  return ziel;
}
