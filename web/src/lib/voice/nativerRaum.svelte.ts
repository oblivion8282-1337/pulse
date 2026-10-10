import { ConnectionState } from 'livekit-client';

import { m } from '$lib/paraglide/messages.js';
import { guilds } from '$lib/stores/guilds.svelte';
import { settings } from '$lib/stores/settings.svelte';
import { sounds } from '$lib/sounds/engine';
import {
  nativerSprachwegDa,
  spracheAnsichtOeffnen,
  spracheAnsichtSchliessen,
  spracheBeitreten,
  spracheBeobachten,
  spracheRaumUebernommen,
  spracheRaumWeg,
  spracheVerlassen,
  spracheZustand,
  type NativerEigenerZustand,
  type NativerTeilnehmer,
  type NativerWunsch,
  type NativerZustand
} from '$lib/platform/iosSprache';
import { abgleichEntscheiden, routeZeigtKanal, verbindungAusHuelle } from './nativAbgleich';
import { NativeBefehle, type NativeHaken, type NativerWirt } from './nativeBefehle';
import type { VoiceResume } from './resume';
import { voiceState } from './state.svelte';
import type { VoiceParticipant } from './livekit.svelte';

/**
 * Der native Weg auf iOS — die Hülle hält den Raum, der Voice-Store spiegelt
 * (Entwurf `docs/superpowers/specs/2026-10-10-ios-nativer-sprachweg-design.md`).
 *
 * **Eigene Datei, weil `livekit.svelte.ts` ein Vielfaches über der
 * Grössen-Policy liegt** und jede Behebung aus dem Bughunt vom 2026-10-11 dort
 * weitere Zeilen gekostet hätte. Der Store ruft hier hinein, sobald `aktiv`
 * ist; die Weichen bleiben dort sichtbar.
 *
 * **Was bewusst LEER bleibt:** `cameraTracks`, `screenTracks`,
 * `localCameraTrack` tragen `livekit-client`-Spuren aus einem JS-`Room`, den
 * es hier nicht gibt; die WebView kann native Spuren nicht zeigen. Die
 * Kacheln zeichnet die native Ansicht (`SpracheAnsicht.swift`). Ebenso leer:
 * Geräteliste, Mikrofon-Pegel, Selbst-Mithören — sie hängen an einem
 * Web-Audio-Graphen. Ein Pegel bei 0 wäre eine Falschaussage, ein fehlender
 * ist eine fehlende Funktion.
 */
export class NativerRaum {
  /** Läuft der Raum (oder sein Aufbau) nativ? Treibt die Weichen im Store
   *  und in der Oberfläche. */
  aktiv = $state(false);
  /** Steht die native Kanalansicht gerade über der Web-App? Fällt sie weg,
   *  ist die Web-Leiste der einzige Weg zurück — sie bietet dann den Griff
   *  an (`VoiceNativeAnsichtGriff.svelte`). */
  ansichtOffen = $state(false);

  /** Mikrofon, Taub, Kamera, Lautstärken — `nativeBefehle.ts`. */
  readonly befehle: NativeBefehle;
  #wirt: NativerWirt;
  #haken: NativeHaken;
  #abmelden: (() => void) | null = null;
  /** Ist der Beitritt durch? Vorher entscheidet das Ergebnis von
   *  `beitreten`, nicht ein Ereignis (s. `#verbindung`). */
  #steht = false;
  /** Die Sitzung der Hülle, in der dieser Spiegel steht (s. `sitzung` in
   *  `SpracheRaum.swift`). */
  #sitzung: number | undefined;

  constructor(wirt: NativerWirt, haken: NativeHaken) {
    this.#wirt = wirt;
    this.#haken = haken;
    this.befehle = new NativeBefehle(wirt, haken);
  }

  // MARK: Beitreten, Übernehmen, Verlassen

  async verbinden(
    wsUrl: string,
    token: string,
    channelId: string,
    channelName: string,
    gen: number,
    opts: { stumm: boolean; taub: boolean; micBeforeDeafen: boolean }
  ): Promise<void> {
    const w = this.#wirt;
    this.#beobachten();
    let z: NativerZustand;
    try {
      z = await spracheBeitreten(wsUrl, token, channelId, channelName, opts.stumm, opts.taub, {
        je: $state.snapshot(settings.voice.userVolumes),
        gesamt: settings.voice.outputVolume
      });
    } catch (e) {
      if (!this.#haken.aktuell(gen)) return;
      w.state = ConnectionState.Disconnected;
      w.channelId = null;
      w.channelName = null;
      w.error = e instanceof Error ? e.message : m.livekit_token_request_failed();
      this.zuruecksetzen();
      return;
    }
    // Überholt, während die Hülle verband: GENAU diesen Raum wieder abräumen
    // — `sitzung` sorgt dafür, dass ein inzwischen gestarteter neuerer nicht
    // mitgerissen wird (Bughunt 2026-10-11, M6).
    if (!this.#haken.aktuell(gen)) {
      await spracheVerlassen(z.sitzung ?? undefined);
      return;
    }
    w.state = ConnectionState.Connected;
    // Beigetreten, aber ohne Mikrofon (verweigerte Erlaubnis, belegtes Gerät):
    // die Hülle lässt den Raum dafür bewusst stehen — man kann zuhören —, also
    // muss die Oberfläche es SAGEN.
    if (z.mikrofonFehler) w.error = z.mikrofonFehler;
    this.#stehen(z, opts.taub, opts.micBeforeDeafen);
    // **Muss hier stehen.** Die Sperre „Audio aktivieren" gehört zum
    // WebKit-Weg; ein stehengebliebenes `true` aus einem früheren Beitritt
    // liess die Oberfläche am 2026-10-10 wie festgehängt aussehen.
    w.audioBlocked = false;
    w.audioBlockGrund = '';
    this.#angekommen();
    // **Erst nach dem Beitritt, und nur, wenn der Nutzer auf den Kanal
    // schaut** (M3) — die Hülle weiss das nicht, das Web schon.
    if (typeof location !== 'undefined' && routeZeigtKanal(location.pathname, channelId)) {
      await this.ansichtOeffnen();
    }
    sounds.play('voice.self_join', { guildId: guilds.guildIdForChannel(channelId) });
  }

  /**
   * Nach einem Reload: hält die Hülle noch einen Raum, wird er übernommen
   * oder verlassen (Entscheidung in `abgleichEntscheiden`). `true`, wenn der
   * Store danach in einem Kanal sitzt.
   *
   * **Bis zum 2026-10-11 fragte niemand** — `spracheZustand()` hatte keinen
   * Aufrufer. Ein Reload liess den Raum weiterlaufen, die Oberfläche hielt
   * sich für getrennt (Bughunt E5).
   */
  async uebernehmen(resume: VoiceResume | null, aktiverServer: string): Promise<boolean> {
    if (!nativerSprachwegDa()) return false;
    const z = await spracheZustand().catch(() => null);
    const abgleich = abgleichEntscheiden({ huelle: z, resume, aktiverServer });
    if (abgleich === 'verlassen') await spracheVerlassen().catch(() => undefined);
    // Bei `uebernehmen` sind `z` und `resume` immer gesetzt; die Prüfung engt
    // nur den Typ ein.
    if (abgleich !== 'uebernehmen' || !z || !resume) return false;
    const w = this.#wirt;
    spracheRaumUebernommen();
    w.channelId = z.kanalId;
    w.channelName = z.kanalName || resume.channelName;
    this.#beobachten();
    w.state = z.verbunden ? ConnectionState.Connected : ConnectionState.Reconnecting;
    this.#stehen(z, resume.deafened, resume.micBeforeDeafen);
    this.ansichtOffen = z.ansichtOffen ?? false;
    this.#angekommen();
    return true;
  }

  /** Auflegen (vom Store aus `disconnect`). Räumt nur den nativen Teil; den
   *  Rest erledigt danach `#teardown`. */
  async verlassen(): Promise<void> {
    this.zuruecksetzen();
    this.#wirt.participants = [];
    this.#wirt.localSpeaking = false;
    await spracheVerlassen();
  }

  /** Spiegel abmelden und vergessen — aus `#teardown`, also für jeden Weg
   *  aus dem Raum. Idempotent. */
  zuruecksetzen(): void {
    this.#abmelden?.();
    this.#abmelden = null;
    this.aktiv = false;
    this.ansichtOffen = false;
    this.#steht = false;
    this.#sitzung = undefined;
  }

  /** Die native Kanalansicht zeigen — vom Griff in der Leiste und nach einem
   *  Beitritt auf die Kanal-Route. */
  async ansichtOeffnen(): Promise<void> {
    if (!this.aktiv) return;
    const z = await spracheAnsichtOeffnen().catch((e: unknown) => {
      console.error('[Sprache] Kanalansicht öffnen fehlgeschlagen', e);
      return null;
    });
    this.ansichtOffen = z?.ansichtOffen ?? false;
  }

  /** Nur die Ansicht wegnehmen — der Raum bleibt. */
  async ansichtSchliessen(): Promise<void> {
    if (!this.aktiv) return;
    await spracheAnsichtSchliessen().catch(() => null);
    this.ansichtOffen = false;
  }

  // MARK: Spiegel

  /** Was nach jedem gelungenen Ankommen gilt — Beitritt wie Übernahme. */
  #angekommen(): void {
    const w = this.#wirt;
    // **`voiceState` ist der Spiegel, den alles ohne `livekit-client` liest**
    // — Watch-Party, HQ-Kacheln, Stream-Töne, Tastenkürzel. Bis zum
    // 2026-10-11 setzte der native Weg ihn nie: `inVoiceChannel()` war auf
    // iOS immer falsch, und ein Watch-Party-Host beendete seine Party schon
    // beim Wegnavigieren (Bughunt E2).
    voiceState.channelId = w.channelId;
    voiceState.connected = w.state === ConnectionState.Connected;
    this.#haken.wachHalten();
    // **Melden UND den Eintrag fürs Wiederaufnehmen schreiben** — der
    // Web-Weg tut das nach jedem Beitritt, der native tat es nie. Ohne den
    // Eintrag gab es nach einem Reload nichts, woran die Seite den Raum
    // wiedererkannt hätte (Bughunt E5).
    this.#haken.melden();
    this.befehle.lautstaerken(
      $state.snapshot(settings.voice.userVolumes),
      settings.voice.outputVolume
    );
  }

  /** Der Beitritt (oder die Übernahme) steht: Sitzung merken, Zustand
   *  spiegeln. Taub reist dabei mit — über den Kanalwechsel wie über einen
   *  Reload —, samt dem Mikrofon-Stand von VOR dem Taubstellen (sonst bliebe
   *  ein Zurücknehmen im neuen Kanal stumm). */
  #stehen(z: NativerZustand, taubVorgabe: boolean, mikroVorTaub: boolean): void {
    this.#steht = true;
    this.#sitzung = z.sitzung;
    this.#zustandSpiegeln(z, taubVorgabe);
    if (this.#wirt.deafened) this.#haken.vorTaubSetzen(mikroVorTaub);
  }

  #zustandSpiegeln(z: NativerZustand, taubVorgabe: boolean): void {
    const w = this.#wirt;
    w.micEnabled = z.mikro;
    w.isCameraOn = z.kamera ?? false;
    if (z.kameraVorn !== undefined) w.cameraFacing = z.kameraVorn ? 'user' : 'environment';
    w.deafened = z.taub ?? taubVorgabe;
    this.#teilnehmer(z.teilnehmer);
  }

  #beobachten(): void {
    this.#abmelden?.();
    this.aktiv = true;
    this.#steht = false;
    this.#abmelden = spracheBeobachten({
      verbindung: (e) => this.#verbindung(e),
      teilnehmer: (liste) => this.#teilnehmer(liste),
      sprechen: (identitaeten) => this.#sprechen(identitaeten),
      eigenerZustand: (e) => this.#eigenerZustand(e),
      // Der Nutzer hat die Ansicht verlassen, nicht den Raum. Die Leiste
      // bietet daraufhin den Griff zurück an.
      ansichtGeschlossen: () => {
        this.ansichtOffen = false;
      },
      wunsch: (e) => this.#wunsch(e)
    });
  }

  /**
   * **Ein Abbruch von aussen räumt jetzt ab** (Bughunt M1) — vorher setzte
   * dieser Hörer nur den Zustand: Wachhalten, WebKits `ambient`, der
   * Merker `aktiv` und der eigene Präsenz-Eintrag blieben stehen. Während
   * des Beitritts entscheidet dagegen sein Ergebnis, nicht dieses Ereignis.
   */
  #verbindung(e: { zustand: string; fehler?: string }): void {
    const w = this.#wirt;
    const zustand = verbindungAusHuelle(e.zustand);
    if (zustand === 'connected') {
      w.state = ConnectionState.Connected;
      if (this.#steht) voiceState.connected = true;
      return;
    }
    if (!this.#steht) return;
    if (zustand === 'reconnecting' || zustand === 'connecting') {
      w.state = ConnectionState.Reconnecting;
      voiceState.connected = false;
    } else if (zustand === 'disconnected') {
      if (e.fehler) w.error = e.fehler;
      spracheRaumWeg();
      this.#haken.abbauen();
    }
  }

  /**
   * Der Spiegel für `eigenerZustand`. **Gemeldet wird jede Änderung an
   * Mikrofon ODER Taub** — bis zum 2026-10-11 nur am Mikrofon, und ein
   * Zurücknehmen von „taub", das den Mikrofon-Stand nicht änderte, erreichte
   * den Gateway nie (Bughunt E1). Vor dem Ende des Beitritts zählt dessen
   * Ergebnis, nicht ein Zwischenstand.
   */
  #eigenerZustand(e: NativerEigenerZustand): void {
    if (!this.#steht) return;
    const w = this.#wirt;
    const vorher = { mikro: w.micEnabled, taub: w.deafened };
    w.micEnabled = e.mikro;
    if (e.kamera !== undefined) w.isCameraOn = e.kamera;
    if (e.kameraVorn !== undefined) w.cameraFacing = e.kameraVorn ? 'user' : 'environment';
    if (e.taub !== undefined) w.deafened = e.taub;
    if (vorher.mikro !== w.micEnabled || vorher.taub !== w.deafened) this.#haken.melden();
  }

  /** Knöpfe der nativen Ansicht, deren Regeln hier liegen — dieselben
   *  Einstiege wie Knöpfe und Tastenkürzel (Admin-Stummschaltung,
   *  Sprechtaste, Watch-Party). */
  #wunsch(e: NativerWunsch): void {
    const w = this.#wirt;
    if (e.aktion === 'mikrofon' && e.an !== w.micEnabled) w.toggleMic();
    else if (e.aktion === 'taub' && e.an !== w.deafened) w.toggleDeafen();
    else if (e.aktion === 'auflegen') void w.disconnect({ reason: 'user' });
  }

  #sprechen(identitaeten: string[]): void {
    const sprechend = new Set(identitaeten);
    const w = this.#wirt;
    w.participants = w.participants.map((p) => ({ ...p, isSpeaking: sprechend.has(p.identity) }));
    w.localSpeaking = w.participants.some((p) => p.isLocal && p.isSpeaking);
  }

  #teilnehmer(liste: NativerTeilnehmer[]): void {
    this.#wirt.participants = liste.map((t) => ({
      identity: t.identity,
      name: t.name,
      userId: t.userId,
      isLocal: t.isLocal,
      isSpeaking: t.isSpeaking,
      audioLevel: t.audioLevel,
      micMuted: t.micMuted,
      cameraOn: t.cameraOn,
      connectionQuality: t.connectionQuality as VoiceParticipant['connectionQuality']
    }));
  }
}
