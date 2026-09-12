/**
 * Reine Rechnung: welche Geraete muss eine Direktnachricht erreichen —
 * importfrei, damit Nodes eingebauter Testlaeufer die Datei ohne Bundler
 * prueft (s. CLAUDE.md „Die Falle").
 *
 * Verschickt wird an Geraete, nicht an Personen (Spec §2): jedes Geraet des
 * Empfaengers UND jedes EIGENE ANDERE Geraet — das eigene AKTUELLE Geraet
 * nicht, es hat den Klartext schon und eine Sitzung mit sich selbst gibt es
 * nicht. Ohne die eigenen anderen Geraete sieht z. B. der eigene Desktop nie,
 * was vom Handy geschrieben wurde.
 *
 * **Die Koexistenz-Regel (Spec §3) ist seit dem 2026-09-12 aufgehoben**
 * (Entscheidung des Eigentuemers): auch ein KONTO ganz ohne haltbares Geraet
 * — reiner Browser-Tab — kann senden und empfangen, Browser gegen Browser
 * eingeschlossen. Der Datenverlust-Schutz, den die Regel einst war, lebt als
 * WARNHINWEIS weiter (`krypto/dmBrowserWarnung.ts`: Browser ohne haltbares
 * Geraet und ohne verbundene Sicherung sieht einmal je Sitzung, dass seine
 * Nachrichten nur hier liegen). Was noch begrenzt: der 14-Tage-Verfall
 * nicht-dauerhafter Geraete serverseitig (`schluessel_verfall.py`) — er
 * galt schon immer fuer ALLEN nicht-dauerhaften Bündel, nicht nur gekoppelte.
 */

/** Wire-Form eines Buendel-Eintrags aus `POST /keys/claim`
 *  (`GeraeteSchluesselOut` im Backend, `keysApi.claim` im Klienten). */
export type GeraeteBuendelEintrag = {
  device_pubkey: string;
  curve25519: string;
  einmalschluessel: string | null;
  rueckfallschluessel: string | null;
  /** Ob DIESES Geraet dauerhaft ist (Electron- oder Android-App, s.
   *  `veroeffentlichen.ts`). Nur noch Anzeige/Etikett, kein Sendekriterium. */
  dauerhaft?: boolean;
  /** Ob DIESES Geraet per Kopplungscode gebunden wurde (Server-Auskunft aus
   *  `DeviceKeyBundle.gekoppelt_am`, nie eine Selbstauskunft des Geraets). */
  gekoppelt?: boolean;
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
 * schlicht keine Eintraege — dann bleibt die leere Liste als Ergebnis, und
 * der Aufrufer meldet `unverschluesselt` sichtbar. Kein Geraet ueberhaupt
 * ist weiterhin der einzige Grund, nicht zu verschluesseln.
 */
export function zielgeraeteBerechnen(
  buendelJeKonto: Record<string, GeraeteBuendelEintrag[]>,
  eigeneUserId: string,
  empfaengerUserId: string,
  eigenerGeraetePubkey: string
): Zielgeraet[] {
  const empfaengerGeraete = buendelJeKonto[empfaengerUserId] ?? [];
  const eigeneGeraete = buendelJeKonto[eigeneUserId] ?? [];

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
