/**
 * Chat-Benachrichtigungen im APK (Capacitor): der Android-WebView kennt kein
 * `new Notification()`, darum zeigt `notifications/inPage.ts` seine Popups auf
 * Android über das native `Hinweise`-Plugin (heads-up, IMPORTANCE_HIGH).
 * Außerhalb des Wrappers No-op; auf alten APKs (< 2026-10-09) wirft der Aufruf
 * — wird gefangen und still ignoriert (Version-Skew, §5.3).
 */
import { registerPlugin } from '@capacitor/core';
import { isCapacitorAndroid } from './runtime';

interface HinweisePlugin {
  zeigen(opts: { titel: string; text: string; id: string }): Promise<void>;
  erlaubt(): Promise<{ erlaubt: boolean }>;
  anfordern(): Promise<void>;
  /** WhatsApp-Stil: MessagingStyle je Chat + Avatar + Badge + Deep-Link. */
  nachricht(opts: {
    chatId: string;
    absender: string;
    text: string;
    id: string;
    avatar?: string;
    ziel?: string;
    anzahl?: number;
  }): Promise<void>;
  zielUrl(): Promise<{ url: string | null }>;
}

const plugin = registerPlugin<HinweisePlugin>('Hinweise');

/** Einmal pro Seitenleben gefragt — die erste Nachricht zeigt den
 *  System-Dialog statt des Popups, danach laufen die Popups frei. */
let angefragt = false;

async function darf(): Promise<boolean> {
  if (!anfragt) {
    anfragt = true;
    const stand = await plugin.erlaubt();
    if (!stand.erlaubt) {
      await plugin.anfordern();
      return false;
    }
  }
  return true;
}

export async function zeigeHinweis(titel: string, text: string, id: string): Promise<void> {
  if (!isCapacitorAndroid()) return;
  try {
    if (await darf()) await plugin.zeigen({ titel, text, id });
  } catch (e) {
    console.warn('[hinweise] zeigen fehlgeschlagen', e);
  }
}

/** Chat-Benachrichtigung (WhatsApp-Stil): gruppiert je chatId, mit
 *  Kontaktbild/Zeitstempel/Badge; beim Tippen navigiert das Web zu ziel. */
export async function zeigeChatNachricht(opts: {
  chatId: string;
  absender: string;
  text: string;
  id: string;
  avatar?: string;
  ziel?: string;
  anzahl?: number;
}): Promise<void> {
  if (!isCapacitorAndroid()) return;
  try {
    if (await darf()) await plugin.nachricht(opts);
  } catch (e) {
    console.warn('[hinweise] nachricht fehlgeschlagen', e);
  }
}

/** SPA-Ziel aus einer angetippten Notification holen und navigieren.
 *  Läuft beim Boot und jedes Mal, wenn die App in den Vordergrund kehrt. */
export async function zielUrlPruefen(): Promise<void> {
  if (!isCapacitorAndroid()) return;
  try {
    const r = await plugin.zielUrl();
    if (r?.url) {
      const { goto } = await import('$app/navigation');
      await goto(r.url);
    }
  } catch (e) {
    console.warn('[hinweise] zielUrl fehlgeschlagen', e);
  }
}

if (isCapacitorAndroid()) {
  void zielUrlPruefen();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void zielUrlPruefen();
  });
}
