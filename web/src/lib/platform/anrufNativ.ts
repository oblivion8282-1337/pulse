/**
 * Die EINE Registrierung des nativen Anruf-Plugins.
 *
 * **Warum eine eigene Datei.** `registerPlugin` darf einen Namen nur einmal
 * belegen; zweimal und Capacitor warnt „Cannot register plugins twice" und
 * verwirft die zweite Anmeldung. Beim Bau von Punkt 40 stand die
 * Registrierung an zwei Stellen — im Anruf-Zustandsautomaten und in der
 * Token-Anmeldung —, und die Warnung stand prompt im Geräte-Log. Es
 * funktionierte trotzdem (die verbleibende Brücke leitet nach Namen weiter),
 * aber die beiden Schnitte wären beim nächsten Methoden-Zuwachs
 * auseinandergelaufen: eine Methode in nur einem der zwei Interfaces, und
 * niemand merkt es, weil TypeScript beide für vollständig hält.
 *
 * Android-Gegenstück: `AnrufPlugin.java` · iOS: `AnrufPlugin.swift`. Gleicher
 * JS-Name, gleiche Methoden; was nur eine der beiden Hüllen kann, ist am
 * Feld vermerkt.
 */
import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';

/** Was mit einer Annehmen/Ablehnen-Aktion aus der nativen Anzeige kommt. */
export interface AnrufAktion {
  aktion: 'annehmen' | 'ablehnen';
  callId: string;
  /** Nur bei einer Aktion aus einem VoIP-Push (iOS): dann kennt das Web den
   *  Anruf noch nicht und braucht den Kanal, um ihn annehmen zu können. */
  channel_id?: string;
  anruf_art?: string;
  einleiter_id?: string;
  einleiter_name?: string;
}

export interface AnrufNativPlugin {
  /** Eingehenden Anruf anzeigen (Android: Notification, iOS: CallKit). */
  ankommen(opts: { callId: string; gegenstelle: string }): Promise<void>;
  /** Anzeige entfernen beziehungsweise den CallKit-Anruf beenden. */
  beenden(): Promise<void>;
  /** PushKit-Token dieses Geräts. **Nur iOS** — Android hat keinen. */
  voipToken(): Promise<{ token: string | null }>;
  addListener(
    event: 'aktion',
    cb: (data: AnrufAktion) => void
  ): Promise<PluginListenerHandle>;
  addListener(
    event: 'voipToken',
    cb: (data: { token: string }) => void
  ): Promise<PluginListenerHandle>;
}

export const anrufNativ = registerPlugin<AnrufNativPlugin>('Anruf');
