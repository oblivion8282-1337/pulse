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

/** Was mit einer Aktion aus der nativen Anzeige kommt. */
export interface AnrufAktion {
  /** `auflegen`: „Beenden" auf einem LAUFENDEN Anruf (bis zum 2026-10-11
   *  kam dafür immer `ablehnen`, Bughunt M5). `getrennt`: der native Raum
   *  ist von aussen weggebrochen. Beide nur iOS. */
  aktion: 'annehmen' | 'ablehnen' | 'auflegen' | 'getrennt';
  callId: string;
  /** Nur bei einer Aktion aus einem VoIP-Push (iOS): dann kennt das Web den
   *  Anruf noch nicht und braucht den Kanal, um ihn annehmen zu können.
   *  `anruf_art` ist `dm` oder `gruppe` — nicht Video (Bughunt G3). */
  channel_id?: string;
  anruf_art?: string;
  einleiter_id?: string;
  einleiter_name?: string;
}

/** Wie das Web ein Ende angestossen hat (`beenden`). Bestimmt, was CallKit
 *  dem Anrufverlauf erzählt; `lokal` geht als Auflegen des Nutzers an
 *  CallKit. Eine ältere iOS-Hülle und Android übergehen das Feld. */
export type AnrufEndgrund =
  | 'lokal'
  | 'gegenseite'
  | 'verpasst'
  | 'fehler'
  | 'anderswo-angenommen'
  | 'anderswo-abgelehnt';

/** Zustand des nativen Anruf-Raums (`AnrufRaum.zustand` in der Hülle). */
export interface AnrufRaumZustand {
  /** Leer, wenn kein Raum steht. */
  kennung: string;
  /** `connected`, `connecting`, `reconnecting`, `disconnected`. */
  zustand: string;
  /** Verbunden seit (ms seit 1970) — `null`, solange nicht verbunden. */
  seit: number | null;
  mikro: boolean;
  kamera: boolean;
  lautsprecher: boolean;
  route: string;
  verschluesselt: boolean;
  /** Letzter E2EE-Zustand einer Spur (`ok`, `decryption_failed`, …) — zur
   *  Diagnose, ob beide Seiten denselben Schlüssel ableiten. */
  e2ee: string;
  mikrofonFehler: string | null;
  callkit: boolean;
  /** Was das Web beim Beitritt mitgab — für die Übernahme nach einem
   *  Reload. */
  kontext: { art?: string; kanalId?: string; rolle?: string; gegenstelle?: string };
}

export interface AnrufNativPlugin {
  /** Eingehenden Anruf anzeigen (Android: Notification, iOS: CallKit). */
  ankommen(opts: { callId: string; gegenstelle: string; video?: boolean }): Promise<void>;
  /** Anzeige entfernen beziehungsweise den CallKit-Anruf beenden — auf iOS
   *  samt nativem Raum. */
  beenden(opts?: { grund?: AnrufEndgrund }): Promise<void>;
  /** PushKit-Token dieses Geräts. **Nur iOS** — Android hat keinen. */
  voipToken(): Promise<{ token: string | null }>;
  /** In der App angenommen — CallKit nimmt mit an. **Nur iOS.** */
  annehmen(opts: { callId: string; gegenstelle: string }): Promise<AnrufRaumZustand>;
  /** Ausgehender Anruf, sobald die Kennung steht. **Nur iOS.** */
  ausgehend(opts: { callId: string; gegenstelle: string }): Promise<AnrufRaumZustand>;
  /** Den nativen Raum betreten. `schluessel`: der Anruf-Schlüssel (32 Bytes,
   *  base64) — fehlt er, läuft der Anruf transportverschlüsselt. **Nur iOS.** */
  raumBeitreten(opts: {
    callId: string;
    wsUrl: string;
    token: string;
    schluessel?: string;
    stumm: boolean;
    art: string;
    kanalId: string;
    rolle: string;
    gegenstelle: string;
  }): Promise<AnrufRaumZustand>;
  raumMikrofon(opts: { an: boolean }): Promise<AnrufRaumZustand>;
  raumKamera(opts: { an: boolean }): Promise<AnrufRaumZustand>;
  raumAusgabe(opts: { lautsprecher: boolean }): Promise<AnrufRaumZustand>;
  raumZustand(): Promise<AnrufRaumZustand>;
  addListener(
    event: 'aktion',
    cb: (data: AnrufAktion) => void
  ): Promise<PluginListenerHandle>;
  addListener(
    event: 'voipToken',
    cb: (data: { token: string }) => void
  ): Promise<PluginListenerHandle>;
  /** **Nur iOS.** Jede Änderung am nativen Raum, ganz (s. `teilnehmer` im
   *  Sprachweg: ein Vollbild braucht keine Reihenfolge). */
  addListener(
    event: 'anrufRaum',
    cb: (data: AnrufRaumZustand) => void
  ): Promise<PluginListenerHandle>;
}

/**
 * Jede Methode, die der native Anrufweg an der Hülle ruft — die Liste, gegen
 * die `anrufNativWeiche.ts` den installierten Bau prüft. Der Bau muss ALLE
 * kennen, sonst läuft der Anruf über den Web-Weg (Begründung an
 * `SPRACHE_METHODEN`, `iosSpracheTypen.ts`).
 *
 * **Vom Typ erzwungen vollständig**: die Schlüssel sind die von
 * `AnrufNativPlugin`; wer dort eine Methode ergänzt, bekommt hier einen
 * Typfehler, bis sie auch in der Liste steht. Das Gegenstück in der Hülle ist
 * `pluginMethods` in `AnrufPlugin.swift`.
 */
export const ANRUF_RAUM_METHODEN: readonly string[] = Object.keys({
  ankommen: true,
  beenden: true,
  voipToken: true,
  annehmen: true,
  ausgehend: true,
  raumBeitreten: true,
  raumMikrofon: true,
  raumKamera: true,
  raumAusgabe: true,
  raumZustand: true,
  addListener: true
} satisfies Record<keyof AnrufNativPlugin, true>);

export const anrufNativ = registerPlugin<AnrufNativPlugin>('Anruf');
