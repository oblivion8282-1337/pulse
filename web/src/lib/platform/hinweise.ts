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
  /** WhatsApp-Stil: MessagingStyle je Chat + Avatar + Badge + Deep-Link
   *  + Lese-Aktion (token/lesePfad/basis). */
  nachricht(opts: {
    chatId: string;
    absender: string;
    text: string;
    id: string;
    avatar?: string;
    ziel?: string;
    anzahl?: number;
    chatName?: string;
    token?: string;
    lesePfad?: string;
    basis?: string;
  }): Promise<void>;
  zielUrl(): Promise<{ url: string | null }>;
}

const plugin = registerPlugin<HinweisePlugin>('Hinweise');

/** Bewusst OHNE Seitenleben-Cache: ein modulares `let anfragt` knallte in
 *  der Laufzeit als "not defined" (HMR-Mischinstanz, Nutzerbefund
 *  2026-10-09) und verschluckte still alle Meldungen. Jeder Aufruf fragt
 *  die native Wahrheit — der Bridge-Call ist billig. */
async function darf(): Promise<boolean> {
  const stand = await plugin.erlaubt();
  if (stand.erlaubt) return true;
  await plugin.anfordern();
  return false;
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
 *  Kontaktbild/Zeitstempel/Badge; beim Tippen navigiert das Web zu ziel;
 *  lesePfad + token treiben die Aktion „Als gelesen markieren" nativ. */
export async function zeigeChatNachricht(opts: {
  chatId: string;
  absender: string;
  text: string;
  id: string;
  avatar?: string;
  ziel?: string;
  anzahl?: number;
  chatName?: string;
  /** Mark-as-read-Pfad relativ zur Gateway-Basis; ohne Wert keine Aktion. */
  lesePfad?: string;
}): Promise<void> {
  if (!isCapacitorAndroid()) return;
  try {
    console.log('[hinweise] zeige:', opts.absender, '| chat', opts.chatId, '| vis', document.visibilityState);
    if (await darf()) {
      let token: string | undefined;
      try {
        token = (await import('$lib/api/storage')).loadTokens()?.access_token;
      } catch {
        /* ohne Token fällt nur die Lese-Aktion weg */
      }
      await plugin.nachricht({
        chatId: opts.chatId,
        absender: opts.absender,
        text: opts.text,
        id: opts.id,
        avatar: opts.avatar,
        ziel: opts.ziel,
        anzahl: opts.anzahl,
        chatName: opts.chatName,
        token,
        lesePfad: opts.lesePfad,
        basis: location.origin + '/api/chat'
      });
    }
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
