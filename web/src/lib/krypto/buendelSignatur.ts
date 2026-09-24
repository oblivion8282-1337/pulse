/**
 * Kanonische Form und Fehlerklassen des signierten Geraete-Buendels
 * (Bughunt 2026-09-23).
 *
 * Bis hierhin trug das Schluesselverzeichnis keinerlei Bindung zwischen
 * Geraet und Schluesseln: der Server konnte `curve25519` und
 * `rueckfallschluessel` in einem Buendel stumm austauschen, und Absender
 * bauten auf den ersetzten Schluesseln Sitzungen auf — genau der Gegner,
 * gegen den E2EE existiert. Jetzt signiert jedes Geraet sein Buendel mit
 * seinem Ed25519-Identitaetsschluessel (`Identitaet.signieren` im
 * wasm-Paket), und der Absender prueft beim Claim (`signaturPruefen`)
 * und pinnt das Geraet per TOFU (`krypto/geraetePinnung.ts`).
 *
 * **Importfrei** gehalten (CLAUDE.md „Die Falle“): die kanonische Form und
 * die Fehlerklassen sind die Verdrahtung zwischen Veroeffentlichen
 * (`veroeffentlichen.ts`) und Pruefen (`senden.ts`) — wenn sie sich
 * aendert, muss das in beiden Faellen dieselbe bleiben. Der Node-Test
 * (`test/buendel-signatur.test.ts`) haelt sie fest, ohne den Bundler oder
 * das WASM-Paket zu brauchen.
 */

/** Die drei Felder, die die Signatur abdeckt. Eintrag in FESTER
 *  Schluesselreihenfolge serialisiert — dieselbe Form auf der Sende- und
 *  der Pruefseite, sonst passt die Signatur nur auf einer Seite. */
export type BuendelKern = {
  device_pubkey: string;
  curve25519: string;
  rueckfallschluessel: string | null;
};

/** Die Zeichenkette, die signiert bzw. verifiziert wird. */
export function buendelAnmeldung(eintrag: BuendelKern): string {
  return JSON.stringify({
    device_pubkey: eintrag.device_pubkey,
    curve25519: eintrag.curve25519,
    rueckfallschluessel: eintrag.rueckfallschluessel
  });
}

/** Eintrag ohne `ed25519`/`bundel_signatur` — Bestandsbuendel, das sich seit
 *  dem Einschlag des Signierens nicht neu veroeffentlicht hat (oder ein
 *  Server, der die Felder unterschlaegt: der Angreifer kann sie nicht
 *  FAELSCHEN, aber weglassen kann er sie). Beide Faelle werden gleich
 *  behandelt: keine neue verschluesselte Sitzung an dieses Geraet. */
export class BuendelUnsigniertFehler extends Error {
  readonly geraet: string;
  constructor(geraet: string) {
    super(
      `Gerät ${geraet} hat kein signiertes Schlüsselbund — App dort einmal öffnen,` +
        ' damit es sich neu veröffentlicht (kurzzeitig auch: älterer Client).'
    );
    this.name = 'BuendelUnsigniertFehler';
    this.geraet = geraet;
  }
}

/** Signatur vorhanden, aber ungueltig — Verfälschung oder kaputtes Buendel.
 *  Kein kontrollierter Pfad fuehrt hier hin, deshalb hart abbrechen statt
 *  das Geraet still zu ueberspringen. */
export class BuendelSignaturFehler extends Error {
  readonly geraet: string;
  constructor(geraet: string) {
    super(`Signatur des Schlüsselbunds von Gerät ${geraet} ist ungültig.`);
    this.name = 'BuendelSignaturFehler';
    this.geraet = geraet;
  }
}

/** Das Geraet meldet sich mit ANDERER Identitaet als beim ersten Kontakt
 *  (TOFU-Pinnung in `geraetePinnung.ts`). Eine gueltige Signatur schliesst
 *  das nicht aus — der Ersatz-Gegner signiert mit seinem EIGENEN Schluessel
 *  —, nur der Vergleich mit dem einmal gesehenen Stand tut es. */
export class GeraeteIdentitaetGeaendertFehler extends Error {
  readonly geraet: string;
  constructor(geraet: string) {
    super(
      `Gerät ${geraet} meldet sich mit anderem Schlüsselbund als beim ersten` +
        ' Kontakt. Wenn das Gerät tatsächlich neu aufgesetzt wurde, kann das' +
        ' nur dort bestätigt werden.'
    );
    this.name = 'GeraeteIdentitaetGeaendertFehler';
    this.geraet = geraet;
  }
}
