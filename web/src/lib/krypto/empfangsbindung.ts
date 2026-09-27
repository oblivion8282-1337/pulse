/**
 * Empfangs-Bindung an das signierte Schlüsselverzeichnis (Bughunt 2026-09-23
 * — der letzte Arm der Absender-Bindung, die mit 7879dfb0 auf der Sendeseite
 * stand).
 *
 * **Das Loch:** der Sitzungsaufbau (Olm Art 0) nutzt die Curve25519-Kurve aus
 * den Postfach-Metadaten — die der Server frei setzt. Wer die Metadaten
 * verdreht UND einen eigenen Prekey gegen unseren öffentlichen
 * Einmalschluessel austauscht, baut eine vollkommen echte Olm-Sitzung „als
 * die Gegenseite“; die Nutzlast (7879dfb0) lügt dann KONSISTENT mit — sie
 * ist nur an die Sitzung gebunden, nicht an eine reale Identität. Betroffen
 * sind DM-Nachrichten wie Gruppenschlüssel-Verteilumschläge gleichermaßen,
 * denn beide reisen als Olm-Umschläge durch denselben Aufbau.
 *
 * **Die Schließung:** bevor eine Sitzung gebaut wird, holt dieser Schritt
 * das behauptete Absendergerät aus dem VERZEICHNIS (`GET /keys/buendel/{id}`
 * — verbrauchsfrei, denn `claim` würde je Gerät einen Einmalschluessel des
 * Absenders verbrennen), prüft Bündel-Signatur und TOFU-Pinnung
 * (`geraetebuendelAuthentifizieren`) und gleicht die Kurve ab. Der Lauf
 * passiert je Zustellung EINMAL, außerhalb der Sitzungssperre, und nur für
 * Aufbau-Umschläge (Art 0) — pro Gerät und Kanal also einmal je
 * Sitzungsleben.
 *
 * **Drei Ausgänge, drei Behandlungen in `zustellungOeffnen.ts`:**
 * * `geprueft` — Kurve steht im Verzeichnis, Sitzung darf gebaut werden
 *   (mit der VERIFIZIERTEN Kurve, nicht der behaupteten);
 * * `spaeter` — Verzeichnis nicht erreichbar: Zustellung liegt liegen und
 *   kommt mit dem nächsten Abholzyklus wieder. Bewusst NICHT als Legacy
 *   durchgelassen — ein bösartiger Server könnte die Prüfung sonst per
 *   500er abschaltbar machen;
 * * `zurueckgewiesen` — Gerät im Verzeichnis unbekannt (widerrufen oder
 *   erfunden), Bündel unsigniert/ungültig, oder Kurve widerspricht: die
 *   Zustellung ist eine Fälschung, wird verworfen und quittiert.
 *
 * **Nicht importfrei** (Netz + WASM + IndexedDB) — die Entscheidungslogik
 * selbst lebt in den getesteten Stücken dahinter (`buendelSignatur.ts`,
 * `wasserstand.ts`); dieser Draht macht nur die Reihenfolge fest.
 */
import { keysApi, type GeraeteSchluessel } from '../api/keys';
import { serversStore } from '../api/servers.svelte';
import { geraetebuendelAuthentifizieren } from './geraetePinnung';

function cloudRoute(): { serverId?: string } {
  return { serverId: serversStore.cloudId() };
}

/** Wird geworfen, wenn das Verzeichnis gerade nicht erreichbar ist — die
 *  Zustellung bleibt liegen (nicht quittieren), der nächste Abholzyklus
 *  versucht es erneut. */
export class EmpfangsBindungOffen extends Error {
  constructor() {
    super('Schlüsselverzeichnis nicht erreichbar — Sitzungsaufbau verschoben');
    this.name = 'EmpfangsBindungOffen';
  }
}

/** Wird geworfen, wenn das Bündel des Absenders fehlt, nicht verifizierbar
 *  ist oder der Kurve widerspricht — Fälschung, Zustellung wird verworfen. */
export class EmpfangsBindungWidersprochen extends Error {
  constructor() {
    super('Absendergerät widerspricht dem Schlüsselverzeichnis');
    this.name = 'EmpfangsBindungWidersprochen';
  }
}

export type EmpfangsBindung =
  | { art: 'geprueft'; curve25519: string }
  | { art: 'spaeter' }
  | { art: 'zurueckgewiesen' };

export async function absenderBinden(
  absenderUserId: string,
  absenderGeraet: string,
  behaupteteKurve: string
): Promise<EmpfangsBindung> {
  let eintraege: GeraeteSchluessel[];
  try {
    // Verbrauchsfreie Leserate, NICHT claim — claim würde je Gerät einen
    // Einmalschluessel des Absenders verbrauchen, ohne ihn je zu benutzen
    // (`schluessel_auskunft.py`, dieselbe Abwägung wie /keys/verschluesselbar).
    eintraege = await keysApi.buendelAuskunft(absenderUserId, cloudRoute());
  } catch (err) {
    console.warn('[postfach] Verzeichnis nicht erreichbar — Sitzungsaufbau verschoben', err);
    return { art: 'spaeter' };
  }
  const geraet = eintraege.find((e) => e.device_pubkey === absenderGeraet);
  if (!geraet) {
    // Widerrufen oder erfunden — beides keine Grundlage für eine Sitzung.
    console.warn('[postfach] Absendergerät im Verzeichnis unbekannt — Zustellung verworfen', {
      absenderGeraet
    });
    return { art: 'zurueckgewiesen' };
  }
  try {
    await geraetebuendelAuthentifizieren(geraet);
  } catch (err) {
    console.warn('[postfach] Absender-Bündel nicht verifizierbar — Zustellung verworfen', err);
    return { art: 'zurueckgewiesen' };
  }
  if (geraet.curve25519 !== behaupteteKurve) {
    console.warn('[postfach] Absender-Kurve widerspricht dem Verzeichnis — Zustellung verworfen', {
      verzeichnis: geraet.curve25519,
      behauptet: behaupteteKurve
    });
    return { art: 'zurueckgewiesen' };
  }
  return { art: 'geprueft', curve25519: geraet.curve25519 };
}
