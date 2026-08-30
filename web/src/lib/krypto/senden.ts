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
 *     mit sich selbst gibt es nicht. `zielgeraeteBerechnen` wendet dabei
 *     zuerst die Koexistenz-Regel an (Spec §3, Bughunt 2026-08-28 FIX 1):
 *     nur wenn BEIDE Konten ein dauerhaftes Geraet haben, gibt es ueberhaupt
 *     Zielgeraete.
 *  2. Je Zielgeraet eine Sitzung — vorhandene laden, sonst ausgehend
 *     aufbauen (`sitzungAusgehend`, verbraucht einen Einmal- oder den
 *     Rueckfallschluessel).
 *  3. Verschluesseln, Sitzung SICHERN (VOR dem Einliefern — der Ratchet ist
 *     schon weitergedreht, ein Absturz danach darf den neuen Zustand nicht
 *     verlieren, s. `sitzungen.ts`), Umschlag sammeln. Lauft je Zielgeraet
 *     unter `mitSitzungssperre` — zwei gleichzeitige Sendungen an dasselbe
 *     Geraet duerfen nicht dieselbe geladene Sitzung unabhaengig weiterdrehen
 *     (s. `sitzungen.ts` Modulkopf).
 *  4. Einliefern — ein `POST /postfach` mit allen Umschlaegen. Die Antwort
 *     (`zustellungen_angelegt`) wird geprueft (Bughunt 2026-08-28, FIX 2):
 *     eine 2xx-Antwort allein ist kein Beweis, dass irgendwo eine Zustellung
 *     entstand — der Server darf jeden angefragten Empfaenger einzeln
 *     uebersprungen haben (unbekanntes Buendel, Kontingent voll). Entstand
 *     KEINE einzige Zustellung, meldet diese Funktion `unverschluesselt` —
 *     was der Aufrufer daraus macht, s. unten. Ein koerperloser 2xx (204,
 *     zweiter Bughunt selbes Datum) gilt dagegen als ZUGESTELLT — s.
 *     `zustellErgebnis.ts`. Ein 404 (Route existiert nicht — aelterer
 *     Server) ist ein DRITTER Fall: nichts kann eingeliefert worden sein,
 *     die Meldung ist deshalb sicher. Jeder andere Fehler wird NICHT
 *     stillschweigend dazu — s. Fehlerbehandlung unten.
 *  5. Lokal ablegen — der eigene Klartext geht in den lokalen Verlauf
 *     (Etappe C1); der Server bekommt ihn nie, es gibt also keine zweite
 *     Kopie. Schlaegt das fehl, ist die Nachricht trotzdem zugestellt
 *     (Schritt 4 ist schon durch) — ein erneutes Einliefern waere ein
 *     Duplikat. Der Fehlschlag wird deshalb NICHT verschluckt, sondern via
 *     `verlaufZustand` sichtbar gemacht (dieselbe Anzeige, die C2 fuer den
 *     Lesepfad nutzt); die Nachricht bleibt trotzdem in der Rueckgabe, denn
 *     sie IST beim Empfaenger angekommen.
 *  6. Die DM-Liste nachziehen (Bughunt 2026-08-28, FIX 3): der verschluesselte
 *     Weg loest — anders als der Klartext-Weg — kein `dm_bump`-Ereignis aus
 *     (der Server sieht den Inhalt nie und weiss nicht einmal, dass DIESES
 *     Geraet gerade selbst gesendet hat). Ohne diesen Schritt ruecke die
 *     eigene, gerade abgeschickte Nachricht nicht an den Kopf der DM-Liste.
 *
 * **Kein Zielgeraet:** hat der Empfaenger keines (und man selbst auch keine
 * weiteren), wird NICHTS verschluesselt und NICHTS eingeliefert, sondern
 * `{ art: 'unverschluesselt' }` zurueckgegeben. Der Name des Falls stammt aus
 * der Koexistenz-Regel (Spec §3) und beschreibt heute nur noch, dass NICHTS
 * eingeliefert wurde — **einen Klartext-Weg fuer DMs gibt es seit Spec §3a
 * nicht mehr** („ohne App-Geraet keine Direktnachrichten"). Der Aufrufer
 * (`app/@me/[[dmChannelId]]`) meldet diesen Fall sichtbar; der Regelfall
 * „Gegenseite ohne App" sperrt schon vorher das Eingabefeld
 * (`krypto/dmSendeSperre.ts`).
 */
import type { Message } from '../api/types';
import { ApiError } from '../api/client';
import { certStore } from '../identity/cert.svelte';
import { keysApi } from '../api/keys';
import { postfachApi, type PostfachNutzlast } from '../api/postfach';
import { serversStore } from '../api/servers.svelte';
import { isElectron, isCapacitorAndroid } from '../platform/runtime';
import { directMessages } from '../stores/directMessages.svelte';
import { verlaufSpeichernPflicht } from '../verlauf';
import { verlaufZustand } from '../verlauf/zustand.svelte';
import { kryptoAccountLaden } from './account.svelte';
import { geraeteKennung } from './geraeteKennung';
import { sitzungLaden, sitzungSichern, mitSitzungssperre } from './sitzungen';
import { baueNachrichtNutzlast, type AnhangAngabe } from './nachrichtNutzlast';
import { anhangAngabeZuAttachment } from './anhangAnzeige';
import { zielgeraeteBerechnen } from './empfaengerGeraete';
import { wurdeZugestellt, deuteEinliefernFehler } from './zustellErgebnis';
import { parseMentionMarkers } from '../components/mentionMarkierungen';

// DMs sind heute cloud-only (Global-Friends Stufe 1) — s. `api/keys.ts`
// Modulkopf (Bughunt 2026-08-28, FIX 4).
function cloudRoute(): { serverId?: string } {
  return { serverId: serversStore.cloudId() };
}

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
  klartext: string,
  // MUSS bereits die KANONISCHE Form sein (`kanonischeAntwortId.ts`) — diese
  // Funktion uebersetzt nicht, s. `nachrichtNutzlast.ts`-Modulkopf.
  replyToId: string | null = null,
  // Verschluesselte Anhaenge (Etappe E): die Klumpen liegen zu diesem
  // Zeitpunkt schon im Objektspeicher (`attachments/uploadVerschluesselt.ts`),
  // hier faehrt nur noch ihr Dateischluessel samt Name, Typ und Maßen mit —
  // INNERHALB des Umschlags, den nur die Zielgeraete oeffnen koennen.
  anhaenge: AnhangAngabe[] = []
): Promise<SendeErgebnis | null> {
  // `null` bedeutet hier ausschliesslich "dieses Geraet ist (noch) nicht
  // angemeldet" — der Aufrufer faellt dann auf Klartext zurueck. Ein
  // unerwarteter Fehler wird bewusst NICHT hierzu gemacht: er faellt weiter
  // durch und wird vom Aufrufer (`app/@me/[[dmChannelId]]/+page.svelte`)
  // sichtbar gemacht, statt als Klartext-Rueckfall gedeutet zu werden.
  const cert = certStore.cert;
  if (!cert) return null;

  const eigeneUserId = cert.claims.user_id;
  // Die eigene Kennung kommt aus der Krypto-Schicht, nicht mehr aus dem
  // Zertifikat (Spec §3b, s. `geraeteKennung.ts`) — der Wert ist derselbe,
  // die Quelle ueberlebt den Wegfall des Zertifikats. EINMAL geholt: sie
  // wird unten noch einmal gebraucht, und jeder Aufruf oeffnet die
  // IndexedDB neu.
  const eigeneKennung = await geraeteKennung();
  // `GeraeteSchluessel` (keys.ts) und `GeraeteBuendelEintrag`
  // (empfaengerGeraete.ts) sind strukturell dieselbe Wire-Form — Letztere
  // importfrei gehalten (s. dort), deshalb zwei benannte Typen statt einem.
  const buendel = await keysApi.claim([eigeneUserId, empfaengerUserId], cloudRoute());
  const ziel = zielgeraeteBerechnen(
    buendel,
    eigeneUserId,
    empfaengerUserId,
    eigeneKennung,
    isElectron() || isCapacitorAndroid()
  );
  if (ziel.length === 0) {
    return { art: 'unverschluesselt' };
  }

  const ident = await kryptoAccountLaden();
  // Eigene, kanonische ID VOR dem Bauen der Nutzlast — sie faehrt selbst mit
  // (jede Gegenseite braucht sie, falls SIE spaeter auf diese Nachricht
  // antwortet) und wird unten unveraendert als `Message.id` verwendet, s.
  // `nachrichtNutzlast.ts`-Modulkopf.
  const nachrichtId = lokaleNachrichtId();
  // Antwort-Kennung faehrt ebenfalls in der Nutzlast mit (statt eines
  // Klartext-Rueckfalls nur wegen `replyToId`) — s. `nachrichtNutzlast.ts`.
  const klartextBytes = baueNachrichtNutzlast(klartext, nachrichtId, replyToId, anhaenge);
  const nutzlasten: PostfachNutzlast[] = [];

  for (const { geraet } of ziel) {
    const umschlag = await mitSitzungssperre(kanalId, geraet.device_pubkey, async () => {
      let sitzung = await sitzungLaden(kanalId, geraet.device_pubkey);
      if (!sitzung) {
        const einmal = geraet.einmalschluessel ?? geraet.rueckfallschluessel;
        if (!einmal) return null; // Kein Schluessel veroeffentlicht -> Geraet gerade unerreichbar.
        sitzung = ident.sitzungAusgehend(geraet.curve25519, einmal);
      }
      const umschlag = sitzung.verschluesseln(klartextBytes);
      // Sichern VOR dem Einliefern — s. Modulkopf.
      await sitzungSichern(kanalId, geraet.device_pubkey, sitzung);
      return umschlag;
    });
    if (!umschlag) continue;
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

  let ergebnis;
  try {
    ergebnis = await postfachApi.einliefern(
      {
        channel_id: kanalId,
        // Dasselbe Geraet, das sich oben aus der Zielmenge herausgerechnet
        // hat — der Server traegt seinen Curve25519-Schluessel in jede
        // Nutzlast, damit ein Empfaenger eine frische Sitzung aufbauen kann.
        device_pubkey: eigeneKennung,
        nutzlasten,
        anhaenge: anhaenge.map((a) => a.id)
      },
      cloudRoute()
    );
  } catch (err) {
    // Deutung s. `deuteEinliefernFehler` (zustellErgebnis.ts, importfrei und
    // dort unit-getestet): 404 = die Route existiert nicht (aelterer
    // Server, zweiter Bughunt 2026-08-28) -> bewiesen NICHTS eingeliefert,
    // Klartext-Rueckfall sicher. Alles andere ist NICHT beweisbar folgenlos
    // — der Server hat den Request womoeglich verarbeitet, nur die Antwort
    // ging verloren. Ein stillschweigender Klartext-Rueckfall koennte hier
    // ein Duplikat beim Empfaenger erzeugen; deshalb wird der Fehler
    // weitergereicht statt hier verschluckt (der Aufrufer entscheidet
    // bewusst, nicht per pauschalem `.catch(() => null)`).
    if (err instanceof ApiError && deuteEinliefernFehler(err.status) === 'unverschluesselt') {
      return { art: 'unverschluesselt' };
    }
    throw err;
  }
  if (!wurdeZugestellt(ergebnis)) {
    // Der Server hat JEDEN angefragten Empfaenger uebersprungen (Bughunt
    // 2026-08-28, FIX 2) — die Nachricht kam nirgends an, obwohl die
    // Anfrage mit 2xx beantwortet wurde. Die lokalen Sitzungen sind zwar
    // schon weitergedreht (s. Modulkopf Schritt 3), aber das darf hier
    // nicht als Erfolg gelten: der Aufrufer faellt auf den Klartext-Weg
    // zurueck, genau wie im Koexistenz-Fall oben.
    return { art: 'unverschluesselt' };
  }

  const nachricht: Message = {
    id: nachrichtId,
    channel_id: kanalId,
    author_id: eigeneUserId,
    content: klartext,
    nonce: null,
    reply_to_id: replyToId,
    created_at: new Date().toISOString(),
    // Rein lokal geparst (Bughunt 2026-08-28, Befund 3) — der Server sieht
    // den Klartext nie, kann Erwaehnungen also auch nicht parsen. Ohne
    // dieses Feld zeigt `renderMessage` die rohe `<@id>`-Markierung an,
    // s. `mentionMarkierungen.ts`-Modulkopf.
    mentions: parseMentionMarkers(klartext),
    // Erkennungsmerkmal fuer die drei REST-Sackgassen (Bearbeiten, Loeschen,
    // Melden-als-Nachricht) — s. `Message.verschluesselt`-Doc in `api/types.ts`.
    verschluesselt: true,
    // Dieselbe Uebersetzung wie beim Empfaenger (`empfangen.ts`), damit die
    // eigene Ansicht die Kachel genauso zeichnet — die Bytes dafuer liegen
    // seit dem Hochladen lokal (`uploadVerschluesselt.ts`).
    ...(anhaenge.length > 0
      ? { attachments: anhaenge.map(anhangAngabeZuAttachment) }
      : {})
  };
  // Der Server bekommt den Klartext nie — ausschliesslich lokal. Die
  // Zustellung (Schritt 4) ist zu diesem Zeitpunkt schon durch, ein
  // Fehlschlag hier darf deshalb NICHT als "nicht gesendet" behandelt
  // werden (das wuerde ueber den Klartext-Rueckfall ein Duplikat beim
  // Empfaenger erzeugen) — stattdessen wird er sichtbar gemacht, s. Modulkopf.
  try {
    await verlaufSpeichernPflicht(kanalId, [nachricht]);
  } catch (err) {
    verlaufZustand.melde(err);
  }

  // Die DM-Liste nachziehen (Bughunt 2026-08-28, FIX 3) — s. Modulkopf
  // Schritt 6. Der Server kennt den Empfaenger bereits (er stand im
  // Kanalzugriff-Check von `POST /postfach`), es muss hier also nichts neu
  // ermittelt werden.
  directMessages.upsertFromEncrypted({
    channel_id: kanalId,
    message_id: nachricht.id,
    otherUserId: empfaengerUserId,
    inhalt: klartext,
    autorId: eigeneUserId,
    erstelltAm: nachricht.created_at,
    anhaenge: nachricht.attachments
  });

  return { art: 'verschluesselt', nachricht };
}
