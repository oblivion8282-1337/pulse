/**
 * WS-Handler für die Fernsteuerung (remote control). Leitet die Inbound-Ops
 * des Consent-Handshakes in den Session-Store (`$lib/remote/session.svelte`)
 * und die Eingabe-Frames in den Sidecar (`$lib/remote/sidecarInput`).
 *
 * Die `op:'error'`-Codes (4050–4054) fängt der Store selbst per `gateway.on()`
 * ab, solange er auf eine Freigabe wartet — deshalb hier kein error-Handler.
 *
 * `remote_signal` trägt SDP/ICE für den direkten Eingabekanal
 * (`$lib/remote/p2p.ts`): der Consent bleibt vollständig auf dem Serverweg,
 * nur die Eingabe-Frames wechseln nach der Verhandlung auf den DataChannel —
 * und fallen ohne ihn wortlos auf den Serverweg zurück.
 */
import { registerWsHandler } from '../handler-registry';
import { remoteSession } from '$lib/remote/session.svelte';
import { remoteP2P } from '$lib/remote/p2p';
import { remoteVorrang } from '$lib/remote/vorrang';
import { remoteZeigerform } from '$lib/remote/zeigerform';
import { eingabeEinspielen } from '$lib/remote/sidecarInput';
import { userCache } from '$lib/stores/users.svelte';

/**
 * Eingabe-Frames einspielen — aber nur, wenn für genau diese Sitzung wirklich
 * eine läuft, in der ICH der Host bin.
 *
 * Der Gateway prüft das ebenfalls, und trotzdem steht es hier noch einmal: die
 * Prüfung kostet nichts, und ihr Gegenstand ist der Zugriff auf Maus und
 * Tastatur dieses Rechners. Alles, was nicht zur bestätigten Sitzung gehört,
 * wird stillschweigend verworfen.
 */
async function eingabe(evt: {
  session_id: string;
  slot: number;
  frames: string[];
}): Promise<void> {
  if (remoteSession.phase !== 'active' || remoteSession.role !== 'host') return;
  if (!evt.session_id || evt.session_id !== remoteSession.sessionId) return;
  if (!Array.isArray(evt.frames) || evt.frames.length === 0) return;
  // Der Vorrang des Hosts gilt maschinenweit, nicht je Stream-Platz: die Wache
  // sitzt in jedem Sidecar-Prozess einzeln, und nur hier ist bekannt, ob
  // IRGENDEINER gerade meldet (Begruendung in `$lib/remote/vorrang.ts`).
  // Weitergereicht statt hier verworfen, damit ein Hello in derselben Nachricht
  // ankommt — sonst liefe die naechste Eingabe in „Eingabe vor dem
  // Hello-Handschlag" und riesse die Sitzung fail-closed ab.
  if (await eingabeEinspielen(evt.slot, evt.session_id, evt.frames, remoteVorrang.aktiv)) return;
  // Fail-closed: der Sidecar hat die Eingabe-Sitzung stillgelegt (oder es gibt
  // gar keine Brücke). Ab hier käme nichts mehr an, auch kein Hoch-Ereignis —
  // eine Sitzung, die nur noch Tasten drückt, ist schlimmer als keine.
  // Erneut prüfen: zwischen Absenden und Antwort kann sie schon geendet haben,
  // und dann gehörte dieses `end()` einer fremden Sitzung.
  if (remoteSession.sessionId === evt.session_id) remoteSession.end();
}

export function register(): void {
  registerWsHandler('remote_request', (evt) => {
    // Namen des Anfragenden holen, BEVOR der Dialog aufgeht. Ohne das steht im
    // Zustimmungsdialog wörtlich „… möchte deinen Bildschirm fernsteuern"
    // (`userCache.displayName` für Unbekannte) — und darauf soll jemand seinen
    // Rechner hergeben. Der Abruf ist gebündelt und entprellt; der Dialog
    // rendert nach, sobald er da ist. Gleiche Schiene wie beim
    // Freundschaftsanfrage-Toast (`handlers/friends.ts`).
    userCache.queue(evt.from_user_id);
    remoteSession._incomingRequest(
      evt.session_id,
      evt.channel_id,
      evt.from_user_id,
      evt.device_id,
      evt.freigabe === true,
    );
  });
  // Nur an den Steuernden: die Kennung seiner gerade angelegten Sitzung.
  registerWsHandler('remote_pending', (evt) =>
    remoteSession._pending(evt.session_id, evt.channel_id, evt.host_user_id),
  );
  registerWsHandler('remote_response', (evt) =>
    remoteSession._response(evt.session_id, evt.accepted),
  );
  registerWsHandler('remote_ended', (evt) =>
    remoteSession._ended(evt.session_id, evt.reason),
  );
  registerWsHandler('remote_canceled', (evt) => remoteSession._dismissIncoming(evt.session_id));
  registerWsHandler('remote_input', (evt) => eingabe(evt));
  // SDP/ICE des direkten Eingabekanals — nur für die eigene, laufende Sitzung
  // (dieselbe Zuordnungsregel wie bei `eingabe`: die Kennung ist alles).
  // Direkt an `p2p`, wie der Frame-Weg unten: der Store hält die Sitzung, aber
  // die Verhandlung geht ihn nichts an.
  registerWsHandler('remote_signal', (evt) => {
    if (remoteSession.phase !== 'active') return;
    if (!evt.session_id || evt.session_id !== remoteSession.sessionId) return;
    // 'vorrang' ist keine Verhandlung, sondern eine Auskunft des Hosts über
    // seinen eigenen Rechner — sie geht an das Modul, das sie anzeigt und das
    // Gehaltene nachzieht (`$lib/remote/vorrang.ts`).
    if (evt.kind === 'vorrang') remoteVorrang._signal(evt.data);
    // 'zeiger' ebenso: die Form des Host-Zeigers, die das Cursor-Echo aus dem
    // Bild nimmt (`$lib/remote/zeigerform.ts`).
    else if (evt.kind === 'zeiger') remoteZeigerform._signal(evt.data);
    // 'zeiger_im_bild' ist der Rückfall dazu: der Host kann die Form nicht mehr
    // melden und legt seinen Zeiger zurück ins Videobild. Der Player blendet
    // dann seinen lokalen aus (`$lib/remote/zeigerImBild.ts`).
    else if (evt.kind === 'zeiger_im_bild') remoteZeigerform._signalImBild(evt.data);
    else remoteP2P.signal(evt.kind, evt.data);
  });
  // Frames, die über den DataChannel hereinkommen, laufen durch DENSELBEN
  // Wächter wie der Serverweg — die Autorisierung hängt an der Sitzung, nicht
  // am Träger. Injektion statt Import, sonst schlösse sich der Kreis
  // session → p2p → handlers → session.
  remoteP2P.setFrameSink((evt) => void eingabe(evt));
}
