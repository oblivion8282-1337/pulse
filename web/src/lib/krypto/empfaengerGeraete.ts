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
 * wird nur, wenn BEIDE Konten mindestens ein TEILNAHMEFAEHIGES Geraet haben —
 * nicht schon, wenn irgendein Buendel existiert. Grund ist Haltbarkeit, nicht
 * Krypto-Faehigkeit: ein beliebiger Browser-Tab kann verschluesseln, aber
 * nichts verlaesslich behalten, und es gibt kein serverseitiges Backup. Ein
 * Konto ganz ohne solches Geraet bliebe sonst unwiderbringlich ohne jede
 * Kopie seines eigenen Verlaufs.
 *
 * Teilnahmefaehig sind zwei Arten (Spec §3a, Punkt 2): eine App (`dauerhaft`)
 * **und ein gekoppelter Browser** (`gekoppelt`). Der gekoppelte Browser ist
 * ausdruecklich ein vollwertiges Geraet — er verfaellt dafuer nach 14 Tagen
 * ohne Benutzung, und ein verfallenes Buendel kommt gar nicht mehr aus
 * `POST /keys/claim` heraus (`schluessel_verfall.py`). Diese Rechnung hier
 * muss deshalb NICHT selbst auf Verfall pruefen — was ankommt, lebt.
 *
 * **Beide Merkmale gehoeren zusammen gelesen.** Stuende hier weiter nur
 * `dauerhaft`, verweigerte der Sendeweg genau die Nachricht, die
 * `GET /keys/verschluesselbar` eine Sekunde vorher zugesagt hat — die Sorte
 * Zwiespalt zwischen Zusage und Ausfuehrung, die im Klartext-Rueckfall schon
 * einmal teuer war.
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
  /** Ob DIESES Geraet per Kopplungscode gebunden wurde (Server-Auskunft aus
   *  `DeviceKeyBundle.gekoppelt_am`, nie eine Selbstauskunft des Geraets).
   *  Fehlt das Feld, gilt es als nicht gekoppelt — fail closed wie oben. */
  gekoppelt?: boolean;
};

/** Ob ein einzelnes Geraet teilnahmefaehig ist: App ODER gekoppelter
 *  Browser. Exportiert, weil dieselbe Frage auch ausserhalb des Faecherns
 *  gestellt wird — zwei Fassungen davon waeren zwei Gelegenheiten, sie
 *  auseinanderlaufen zu lassen. */
export function geraetZaehlt(geraet: GeraeteBuendelEintrag): boolean {
  return geraet.dauerhaft === true || geraet.gekoppelt === true;
}

/** Ob mindestens EIN Geraet der Liste zaehlt — die Koexistenz-Regel haengt am
 *  KONTO, nicht am einzelnen Geraet. */
function kontoHatDauerhaftesGeraet(geraete: GeraeteBuendelEintrag[]): boolean {
  return geraete.some(geraetZaehlt);
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
