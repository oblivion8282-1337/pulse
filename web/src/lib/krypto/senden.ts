/**
 * Verschluesselt eine Direktnachricht und liefert sie ein — Task 2 der
 * Etappe D2 (`docs/superpowers/plans/2026-08-28-etappe-d2-klient-
 * verschluesselt.md`).
 *
 * Ablauf, und jeder Schritt kann schiefgehen:
 *
 *  1. Geraetebuendel holen (`POST /keys/claim`) — Empfaenger UND die eigenen
 *     anderen Geraete (`empfaengerGeraete.ts`, Spec §2). Das eigene AKTUELLE
 *     Geraet bleibt aussen vor: es hat den Klartext schon, und eine Sitzung
 *     mit sich selbst gibt es nicht.
 *  2. Je Zielgeraet eine Sitzung — vorhandene laden, sonst ausgehend
 *     aufbauen (`sitzungAusgehend`, verbraucht einen Einmal- oder den
 *     Rueckfallschluessel).
 *  3. Verschluesseln, Sitzung SICHERN (VOR dem Einliefern — der Ratchet ist
 *     schon weitergedreht, ein Absturz danach darf den neuen Zustand nicht
 *     verlieren, s. `sitzungen.ts`), Umschlag sammeln.
 *  4. Einliefern — ein `POST /postfach` mit allen Umschlaegen.
 *  5. Lokal ablegen — der eigene Klartext geht in den lokalen Verlauf
 *     (Etappe C1); der Server bekommt ihn nie.
 *
 * **Koexistenz (Spec §3):** hat der Empfaenger kein Geraet (und man selbst
 * auch keine weiteren), gibt es kein einziges Zielgeraet — dann wird NICHTS
 * verschluesselt und NICHTS eingeliefert, sondern `{ art: 'unverschluesselt' }`
 * zurueckgegeben. Der Aufrufer nimmt dann den heutigen Klartext-Weg (WS
 * `send`). Das ist der Normalfall der Koexistenz-Regel, kein Fehler.
 */
import type { Message } from '../api/types';
import { certStore } from '../identity/cert.svelte';
import { loadKeypair } from '../identity/keypair.svelte';
import { keysApi } from '../api/keys';
import { postfachApi, type PostfachNutzlast } from '../api/postfach';
import { verlaufSpeichern } from '../verlauf';
import { kryptoAccountLaden } from './account.svelte';
import { sitzungLaden, sitzungSichern } from './sitzungen';
import { baueNutzlast } from './nutzlast';
import { signiereNutzlast } from './nachweis';
import { zielgeraeteBerechnen } from './empfaengerGeraete';

export type SendeErgebnis =
  | { art: 'verschluesselt'; nachricht: Message }
  | { art: 'unverschluesselt' };

/**
 * Eine rein lokale Nachrichten-ID — der Server sieht diese Nachricht nie,
 * kann ihr also keine Snowflake zuteilen. Rein numerisch (Millisekunden-
 * Zeitstempel + Zufallsziffern gegen Kollisionen bei gleichzeitigem Senden
 * von zwei Geraeten desselben Kontos), damit `sortierSchluessel`s
 * `padStart` (lokales Verlauf-Schema, `verlauf/satz.ts`) sie weiterhin
 * lexikografisch nach Zeit einordnet.
 */
function lokaleNachrichtId(): string {
  const zeit = Date.now().toString().padStart(13, '0');
  const zufall = Math.floor(Math.random() * 1e7)
    .toString()
    .padStart(7, '0');
  return zeit + zufall;
}

export async function sendeVerschluesselt(
  kanalId: string,
  empfaengerUserId: string,
  klartext: string
): Promise<SendeErgebnis | null> {
  const keypair = await loadKeypair();
  const cert = certStore.cert;
  if (!keypair || !cert) return null; // Kein Nachweis moeglich -> Aufrufer faellt zurueck.

  const eigeneUserId = cert.claims.user_id;
  // `GeraeteSchluessel` (keys.ts) und `GeraeteBuendelEintrag`
  // (empfaengerGeraete.ts) sind strukturell dieselbe Wire-Form — Letztere
  // importfrei gehalten (s. dort), deshalb zwei benannte Typen statt einem.
  const buendel = await keysApi.claim([eigeneUserId, empfaengerUserId]);
  const ziel = zielgeraeteBerechnen(
    buendel,
    eigeneUserId,
    empfaengerUserId,
    cert.claims.device_pubkey
  );
  if (ziel.length === 0) {
    return { art: 'unverschluesselt' };
  }

  const ident = await kryptoAccountLaden();
  const klartextBytes = new TextEncoder().encode(klartext);
  const nutzlasten: PostfachNutzlast[] = [];

  for (const { geraet } of ziel) {
    let sitzung = await sitzungLaden(kanalId, geraet.device_pubkey);
    if (!sitzung) {
      const einmal = geraet.einmalschluessel ?? geraet.rueckfallschluessel;
      if (!einmal) continue; // Kein Schluessel veroeffentlicht -> Geraet gerade unerreichbar.
      sitzung = ident.sitzungAusgehend(geraet.curve25519, einmal);
    }
    const umschlag = sitzung.verschluesseln(klartextBytes);
    // Sichern VOR dem Einliefern — s. Modulkopf.
    await sitzungSichern(kanalId, geraet.device_pubkey, sitzung);
    nutzlasten.push({
      art: umschlag.art(),
      daten: umschlag.daten(),
      empfaenger: [geraet.device_pubkey]
    });
  }

  if (nutzlasten.length === 0) {
    // Alle Zielgeraete waren ohne verwertbaren Schluessel — dieselbe
    // Koexistenz-Antwort wie "kein Geraet ueberhaupt".
    return { art: 'unverschluesselt' };
  }

  const nutzlastBytes = baueNutzlast('postfach', kanalId, ...nutzlasten.map((n) => n.daten));
  const signatur = await signiereNutzlast(keypair, nutzlastBytes);
  await postfachApi.einliefern({ channel_id: kanalId, cert: cert.raw, signatur, nutzlasten });

  const nachricht: Message = {
    id: lokaleNachrichtId(),
    channel_id: kanalId,
    author_id: eigeneUserId,
    content: klartext,
    nonce: null,
    created_at: new Date().toISOString()
  };
  // Der Server bekommt den Klartext nie — ausschliesslich lokal.
  await verlaufSpeichern(kanalId, [nachricht]);

  return { art: 'verschluesselt', nachricht };
}
