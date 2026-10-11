import { request } from '$lib/api/client';
import { serversStore } from '$lib/api/servers.svelte';
import { darfMelden, serverStandUnsicher, type Drosselstand } from './badgeDrossel';

/** Drosselstand dieser Sitzung — was zuletzt gemeldet wurde und wann. */
const stand: Drosselstand = { letzterWert: null, letzteZeit: 0, bereit: false };
/** Zuletzt GERECHNETER Wert — auch wenn er nicht gemeldet wurde. Den braucht
 *  `badgeMeldungFreigeben`, um nach dem Wiederverbinden nachzumelden. */
let gerechnet: number | null = null;
/** Steht ein Nachmelden an (`badgeNachVerbindung`)? */
let nachmelden = false;

/**
 * Den eigenen Ungelesen-Stand an den Server melden, damit er ihn im Push
 * mitschicken kann (`aps.badge`).
 *
 * **Warum der Klient meldet und der Server nicht rechnet:** Bei
 * verschlüsselten DMs — dem Normalweg — kennt der Server die Zahl nicht
 * (Begründung im Modulkopf von `services/chat-gateway/.../badgezaehler.py`).
 * Solange die App wach ist, ist dieser Klient die Wahrheit; der Serverzähler
 * ist nur die Fortschreibung für die Zeit, in der niemand rechnen kann.
 *
 * **Gilt für JEDE Plattform, nicht nur die iOS-Hülle.** Wer am Rechner liest,
 * soll damit die Plakette am Telefon abräumen — dieselbe Erwartung wie bei
 * WhatsApp Web. Der Aufruf geht an die CLOUD: nur sie verschickt Pushes (sie
 * gelten DMs, und die sind Cloud-only), also führt nur sie den Zähler. Bis
 * zum 2026-10-11 ging er an den AKTIVEN Server — mit einem Self-Host davor
 * setzte das dessen Zähler zurück, während der in der Cloud weiter wuchs
 * (Bughunt T2).
 */
export function badgeMelden(wert: number): void {
  gerechnet = wert;
  const jetzt = Date.now();
  if (!darfMelden(stand, wert, jetzt)) return;
  const vorher = stand.letzterWert;
  stand.letzterWert = wert;
  stand.letzteZeit = jetzt;
  void request<void>(
    '/fcm/badge',
    { method: 'POST', body: { anzahl: wert } },
    { serverId: serversStore.cloudId() }
  ).catch(() => {
    // Fehlgeschlagen (offline, 429, nicht angemeldet): den Merker
    // zurücknehmen, sonst gilt ein nie angekommener Wert als gemeldet und
    // der nächste Durchlauf schweigt über denselben Stand.
    if (stand.letzterWert === wert) stand.letzterWert = vorher;
  });
}

/**
 * Freigabe: Ab jetzt kann dieser Klient seine Zahl verteidigen.
 *
 * Gerufen, sobald der Postfach-Abholweg einer Sitzung durch ist (auch wenn
 * er wegen abgeschalteter Krypto-Schalter gar nichts zu tun hatte) —
 * `ws/handlers/chat.ts::postfachAbholenUndAnzeigen`. Vorher ist die
 * Ungelesen-Rechnung des Klienten noch nicht geladen und seine 0 bedeutet
 * „weiss ich nicht", nicht „alles gelesen" (s. `badgeDrossel.ts`).
 */
export function badgeMeldungFreigeben(): void {
  stand.bereit = true;
  if (!nachmelden) return;
  nachmelden = false;
  serverStandUnsicher(stand);
  // Hat sich die Zahl durch das Abholen geändert, meldet der `$effect` sie
  // gleich selbst. Hat sie sich NICHT geändert, läuft er nicht — dann
  // meldet dieser Nachzügler sie (im nächsten Takt, damit der `$effect` mit
  // der frischen Zahl zuerst dran ist).
  setTimeout(() => {
    if (stand.letzterWert === null && gerechnet !== null) badgeMelden(gerechnet);
  }, 0);
}

/**
 * Die Verbindung zur Cloud steht (wieder) — `ready`. Das nächste Freigeben
 * meldet den Stand neu, auch wenn er gleich geblieben ist: der Server hat in
 * der Zwischenzeit womöglich selbst hochgezählt (`serverStandUnsicher`,
 * Bughunt T12). Nur hier, nicht bei jedem `postfach_neu`: solange eine
 * Verbindung offen ist, pusht der Server nicht und zählt nichts.
 */
export function badgeNachVerbindung(): void {
  nachmelden = true;
}

/** Nach dem Abmelden: der nächste Anmelder soll seinen Stand frisch melden
 *  dürfen, auch wenn er zufällig dieselbe Zahl hat — und erst wieder, wenn
 *  SEINE Lage geladen ist. */
export function badgeMeldungZuruecksetzen(): void {
  stand.letzterWert = null;
  stand.letzteZeit = 0;
  stand.bereit = false;
  gerechnet = null;
  nachmelden = false;
}
