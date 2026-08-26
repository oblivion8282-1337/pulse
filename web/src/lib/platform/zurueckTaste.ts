/**
 * Android-Zurück-Taste (und Zurück-Geste) für die Capacitor-Hülle.
 *
 * Ohne diesen Handler schließt die Taste die Activity. Stattdessen navigiert
 * sie IN der App die Bildschirm-Hierarchie hoch — derselbe Weg, den die
 * Zurück-Pfeile der UI gehen — und erst ganz oben (Bereichs-Wurzeln) wird die
 * App in den Hintergrund minimiert statt geschlossen.
 *
 * Priorität pro Druck:
 *   1. URL-Hierarchie: Kanal → Raum-Ansicht → Räume, DM → Chats, …
 *   2. Kein Elter bekannt → Browser-Historie zurück (falls vorhanden).
 *   3. Histrien-Ende + Wurzel-Bildschirm → App minimieren.
 */
import { App as CapApp } from '@capacitor/app';
import { goto } from '$app/navigation';
import { page } from '$app/state';
import { isCapacitorAndroid } from './runtime';

/** Pfad → übergeordnete Route. Erster Treffer gewinnt. */
const ELTERN: { test: RegExp; ziel: (m: RegExpMatchArray) => string }[] = [
  // Kanal-Bildschirm (Chat wie Voice) → Kanalliste des Raums — dasselbe Ziel
  // wie der Zurück-Pfeil in ChatView/VoiceChannelView.
  {
    test: /^\/app\/guilds\/([^/]+)\/channels\/[^/]+$/,
    ziel: (m) => `/app/rooms/${m[1]}`
  },
  // Raum-Ansicht → Räume-Übersicht.
  { test: /^\/app\/rooms\/[^/]+$/, ziel: () => '/app/rooms' },
  // Entdecken ist der Ausgang aus der Räume-Leere → zurück in die Räume.
  { test: /^\/app\/discover$/, ziel: () => '/app/rooms' },
  // DM-Chat → Chats-Liste.
  { test: /^\/app\/@me\/[^/]+$/, ziel: () => '/app/@me' }
];

/** Die vier Bereichs-Wurzeln — hier beendet Zurück die Navigation. */
const WURZELN = new Set(['/app/rooms', '/app/@me', '/app/friends', '/app/me']);

function elterVon(pfad: string): string | null {
  for (const regel of ELTERN) {
    const m = pfad.match(regel.test);
    if (m) return regel.ziel(m);
  }
  return null;
}

let registriert = false;

/** Einmalig registrieren (Idempotent). Nur in der Android-Hülle aktiv. */
export function registriereZurueckTaste(): void {
  if (registriert || !isCapacitorAndroid()) return;
  registriert = true;
  void CapApp.addListener('backButton', () => {
    const pfad = page.url.pathname;
    const elter = elterVon(pfad);
    if (elter) {
      void goto(elter, { noScroll: true });
      return;
    }
    // Kein bekannter Elter: Historie zurück — aber nur innerhalb der App
    // (kein Zusprung VOR den App-Einstieg; Referrer derselbe Origin reicht
    // als Näherung nicht, deshalb Historie-Länge als Begrenzer nutzen wir
    // nicht — goto-Fallback ist minimize, falls back() nichts bewirkt).
    if (window.history.length > 1 && !WURZELN.has(pfad)) {
      window.history.back();
      // Fallback: falls die Historie nicht in die App gehört (kein
      // Navigationseffekt), nach kurzer Frist doch minimieren.
      window.setTimeout(() => {
        if (page.url.pathname === pfad) void CapApp.minimizeApp();
      }, 250);
      return;
    }
    void CapApp.minimizeApp();
  });
}
