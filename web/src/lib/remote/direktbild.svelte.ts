/**
 * **Direktbild (P2P, Stufe 1)** — das Videobild der Fernsteuerung geht direkt
 * vom Host zum Steuernden, an jedem Server vorbei. Der Server sieht von der
 * Verbindung nur zwei SDP-Texte; die tragen dieselbe Consent-Schranke wie der
 * Eingabe-Kanal (`remote_signal` fließt nur in aktiven Sitzungen).
 *
 * ## Wer offeriert, wer antwortet
 *
 * Der **Player des Steuernden offeriert** (recvonly video+audio, Stun-only,
 * Kandidaten bis zum Abschluss gesammelt — non-trickle wie der WHEP-Weg), der
 * **Sidecar des Hosts antwortet**. Die Rollenwahl steht im Plan
 * (`docs/plans/2026-09-06-fernsteuerung-p2p-bild-stufe1.md`): der Player wird
 * erst geöffnet, wenn die Sitzung steht, und hat mit `whep.rs` bereits einen
 * Peer-Connection-Bau; der Sidecar kennt sein Gegenüber vor dem Weckruf nicht.
 *
 * ## Zwei Rollen, ein Modul
 *
 * Wie `ablage.ts` hier daneben: die Verhandlung ist UNSYMMETRISCH — der
 * Steuernde treibt sie an (Player-Offer → `bild_offer` → `bild_answer`), der
 * Host antwortet nur. Beide Rollen leben trotzdem hier, weil sie denselben
 * Draht und dieselbe Lebensdauer teilen: Aufbau bei `remote_response`, Abbau
 * bei Sitzungsende.
 *
 * ## Kein stiller Rückfall
 *
 * Scheitert die Direktverbindung (NAT, Router), endet sie mit einer Meldung —
 * sie fällt NICHT wortlos auf den Serverweg zurück. Das ist Stufe 1
 * ausdrücklich so gewollt (Plan, „Nicht-Ziele"): ein stiller Wechsel würde den
 * zwei Rechnern unterschieben, sie sprächen mit dem Server, wo sie dachten,
 * direkt zu sprechen — und die Messung „was bringt P2P?" wäre wertlos.
 */

import { gsr } from '$lib/stream/gsr';
import { aktiverDirektPlatz } from '$lib/devices/wecken';
import { onDirectState } from '$lib/player/client';
import { nativePlayerSessions } from '$lib/player/store.svelte';
import { isElectron } from '$lib/platform/runtime';
import type { RemoteSignalKind } from '$lib/ws/handlers/types';

/** Der Zustand der Direktverbindung, so wie ihn beide Seiten sehen. */
export type DirektZustand =
  | 'aus'
  | 'verbinde'
  | 'live'
  | 'fehlgeschlagen';

/**
 * Der Zustand der Direktverbindung, so wie ihn beide Seiten sehen. Bewusst EIN Wert und nicht
 * je Seite: es gibt in Stufe 1 höchstens eine Direktverbindung, und jede Rolle
 * setzt ihn für sich — der Steuernde beim Verhandeln, der Host beim Empfang
 * der Sidecar-Ereignisse.
 */
const zustand = $state<{ wert: DirektZustand }>({ wert: 'aus' });


/** Der Player-Fenster-Sitzung des Steuernden — für das saubere Ende. */
let playerSitzung: number | null = null;
/** Der Registry-Schlüssel des Direktfensters, damit der Abbau dieselbe
 *  Sitzung trifft, die aufgegangen ist. */
let registrySchluessel: { channelId: string; hostUserId: string; slot: number } | null = null;

/** Hört der Host gerade auf die Sidecar-Ereignisse? (Abo-Verwaltung.) */
let hostAbo: (() => void) | null = null;

/** Hört der Steuernde gerade auf die Player-Ereignisse? */
let controllerAbo: (() => void) | null = null;

/** Aktueller Zustand — für die Anzeige beim Steuernden. */
export function direktZustand(): DirektZustand {
  return zustand.wert;
}

function setze(w: DirektZustand): void {
  zustand.wert = w;
}

/**
 * Alles zurück — Sitzungsende oder -wechsel. Idempotent: `#reset` der Sitzung
 * ruft es bei jedem Durchlauf, auch wenn nie eine Direktverbindung entstand.
 */
export function abraeumen(rolle: 'controller' | 'host' | null): void {
  if (rolle === 'controller') {
    // Über die Registry schliessen: die trägt Kanal/Host/Platz, und nur sie
    // räumt auch den Eintrag weg, über den die Eingabe-Erfassung läuft.
    if (registrySchluessel) {
      nativePlayerSessions.close(
        registrySchluessel.channelId,
        registrySchluessel.hostUserId,
        registrySchluessel.slot,
      );
    }
    playerSitzung = null;
    registrySchluessel = null;
  }
  if (controllerAbo) {
    controllerAbo();
    controllerAbo = null;
  }
  if (hostAbo) {
    hostAbo();
    hostAbo = null;
  }
  setze('aus');
}

// ── Steuernden-Seite: Offerieren, Answer einspeisen, Zustand mitlesen ───────

/**
 * Die Direktverhandlung als Steuernder ANSTOSSEN: Player-Fenster im
 * Direktmodus öffnen, Offer holen und als `bild_offer` hinausschicken.
 *
 * `answerEmpfangen` ist die Rückfahrkarte: sie wird vom Sitzungs-Handler
 * gerufen, wenn `bild_answer` hereinkommt, und speist die Answer in den
 * Player. Aufgeteilt in zwei Schritte, weil die Antwort erst nach einem
 * Server-Umlauf da sein kann — das Modul selbst bleibt zustandslos dazwischen.
 *
 * `openFehlgeschlagen` trennt die zwei Fehlerursachen, die der Nutzer sehen
 * muss: fehlt der Player (Browser, alter Bau), ist P2P hier schlicht nicht
 * möglich — die Sitzung endet mit einer lesbaren Meldung statt eines schwarzen
 * Fensters.
 */
export async function steuerndStart(
  channelId: string,
  hostUserId: string,
  sessionId: string,
  slot: number,
  send: (kind: RemoteSignalKind, data: unknown) => boolean,
  openFehlgeschlagen: (meldung: string) => void,
): Promise<void> {
  if (!isElectron()) {
    openFehlgeschlagen('direct_no_player');
    return;
  }
  const api = window.pulse?.player;
  if (!api) {
    openFehlgeschlagen('direct_no_player');
    return;
  }
  setze('verbinde');
  // **Das Fenster geht über die REGISTRY, nicht über einen nackten `openPlayer`.**
  // Die Eingabe-Erfassung wird über `nativePlayerSessions.fuerHost` bewaffnet —
  // ein Fenster, das nur hier direkt geöffnet würde, sähe die Fernsteuerung
  // nicht, und der Steuernde säße vor einem Bild, das nichts reagiert. Genau
  // so sah der erste P2P-Lauf aus.
  const sitzung = nativePlayerSessions.ensureDirekt(channelId, hostUserId, slot);
  // Die Fensternummer steht erst nach dem asynchronen Öffnen — kurz warten,
  // statt mit Polling die Registry zu foltern. 5 s sind großzügig: Öffnen ist
  // ein Prozess-Start plus RPC, kein Netzweg.
  let offen: number | null = null;
  for (let warte = 0; warte < 50; warte++) {
    offen = sitzung.fensterSitzung;
    if (offen !== null) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (offen === null) {
    openFehlgeschlagen('direct_no_player');
    setze('aus');
    return;
  }
  playerSitzung = offen;
  registrySchluessel = { channelId, hostUserId, slot };
  // Die Zustandsereignisse der Direktverbindung lesen — der Player meldet den
  // PC-Wechsel getrennt vom Fensterzustand (`client.ts::onDirectState`).
  controllerAbo = onDirectState((zustandNeu) => {
    if (playerSitzung !== offen) return;
    if (zustandNeu === 'live') setze('live');
    else if (zustandNeu === 'failed') setze('fehlgeschlagen');
    else if (zustandNeu === 'closed') abraeumen('controller');
  });
  let antwort: { ok?: boolean; sdp?: string };
  try {
    antwort = (await api.directStart?.(offen)) as typeof antwort;
  } catch {
    openFehlgeschlagen('direct_no_player');
    setze('aus');
    return;
  }
  if (!antwort?.ok || typeof antwort.sdp !== 'string') {
    openFehlgeschlagen('direct_start_fehlgeschlagen');
    setze('aus');
    return;
  }
  // Der Offer hinaus — der Gateway reicht ihn peer-gebunden an den Host.
  send('bild_offer', { session_id: sessionId, slot, sdp: antwort.sdp });
}

/**
 * Die Answer des Host-Sidecars in den Player einspeisen (Steuernden-Seite).
 * Aus dem `remote_signal`-Handler gerufen; die Kennung hat der Handler schon
 * gegen die laufende Sitzung geprüft.
 */
export async function steuerndAnswer(session: number | null, sdp: string): Promise<void> {
  const api = window.pulse?.player;
  if (!api || session === null) return;
  try {
    await api.directSignal?.(session, sdp);
  } catch {
    setze('fehlgeschlagen');
  }
}

/** Die Player-Fenster-Sitzung des Steuernden — fürs saubere Ende von außen. */
export function steuerndSitzung(): number | null {
  return playerSitzung;
}

// ── Host-Seite: Offer annehmen, Answer zurückschicken, Ereignisse lesen ─────

/**
 * Die Host-Rolle vorbereiten: die `bild_offer`-Beantwortung samt Sidecar-RPC
 * scharf stellen. Gerufen aus dem Sitzungs-Handler bei `remote_response` auf
 * der Host-Seite — `slot` ist der Platz des wartenden Direktstroms
 * (`aktiverDirektPlatz()`), `send` geht über dieselbe Verbindung wie sonst.
 *
 * Scheitert der Sidecar-RPC, geht KEINE Answer hinaus: der Steuernde sieht
 * seine Verhandlung als gescheitert (Zeitablauf im Player), statt ein
 * „live"-Versprechen zu bekommen, das der Sidecar nicht einlöst. Der
 * Nachtwach von `wecken.ts` schläft den Rechner nach seiner Frist wieder ein.
 */
export async function hostBereit(
  sessionId: string,
  send: (kind: RemoteSignalKind, data: unknown) => boolean,
): Promise<void> {
  const slot = aktiverDirektPlatz();
  if (slot === null) return;
  setze('verbinde');
  hostAbo = await gsr.onEvent((ev) => {
    if (ev.ev !== 'direct_state' || ev.slot !== undefined && ev.slot !== slot) return;
    if (ev.state === 'live') setze('live');
    else if (ev.state === 'failed') {
      setze('fehlgeschlagen');
    }
  });
  // Die Beantwortung selbst hängt an einem Setter, den der Signal-Handler
  // ruft — sie braucht den Offer, der erst noch kommt.
  hostAntwort = (sdp: string) => {
    void (async () => {
      // Kein RPC, keine Answer, keine Verhandlung — absichtlich STUMM nach
      // außen: der Steuernde sieht den Fehlschlag an seinem eigenen
      // Zeitablauf. Ein `bild_answer` mit Fehlertext wäre ein Kanal, über
      // den ein Host lügen könnte.
      const antwort = await gsr.directOffer(slot, sdp);
      if (!antwort?.ok || typeof antwort.sdp !== 'string') {
        setze('fehlgeschlagen');
        return;
      }
      send('bild_answer', { session_id: sessionId, sdp: antwort.sdp });
    })();
  };
}

/** Der Setter aus [`hostBereit`]; `null`, solange keine Host-Rolle läuft. */
let hostAntwort: ((sdp: string) => void) | null = null;

/**
 * Ein `bild_offer` des Steuernden ist angekommen (Host-Seite). Nur
 * weiterzuleiten an den Sidecar des gemerkten Platzes — die Antwort geht als
 * `bild_answer` wieder hinaus.
 */
export function hostOffer(sdp: string): void {
  if (hostAntwort) hostAntwort(sdp);
}

/** Host-Seite aufräumen — Sitzungsende. Löst die Direktverbindung am Sidecar. */
export function hostEnde(): void {
  const slot = aktiverDirektPlatz();
  if (slot !== null) void gsr.directStop(slot);
  if (hostAbo) {
    hostAbo();
    hostAbo = null;
  }
  hostAntwort = null;
  setze('aus');
}

/**
 * Die Fassade, die der Sitzungs-Store kennt. Ein Objekt statt freier
 * Funktionen — dieselbe Form wie `remoteSession`/`remoteP2P` daneben, damit
 * die Verbrauchsstelle ohne Erklärung lesbar bleibt.
 */
export const direktbild = {
  direktZustand,
  steuerndStart,
  steuerndAnswer,
  steuerndSitzung,
  hostBereit,
  hostOffer,
  hostEnde,
  abraeumen,
};
