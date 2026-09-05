/**
 * Der Sprachraum eines Gastes — eine eigene, kleine Fassung.
 *
 * **Warum nicht der bestehende `voice`-Store:** der hängt an Konto, Gateway,
 * Einstellungs-Speicher, Rauschfilter, Fernsteuerung, Watch-Party und einem
 * Dutzend Stores, die es auf der Gastseite nicht gibt. Ein Gast-Zweig durch
 * all das hindurch wäre teurer und zerbrechlicher als diese eine Datei, die
 * nur kann, was ein Gast darf: sprechen, Kamera, zuhören, zusehen.
 *
 * Was hier bewusst FEHLT: Bildschirm teilen (ein Gast darf es nicht, das
 * LiveKit-Token lässt die Quelle gar nicht zu), Datenkanal (trägt in Pulse
 * Fernsteuer- und Zeigerdaten), Wiederverbinden über Tage, Geräteumschaltung
 * im laufenden Betrieb.
 */

import {
  ConnectionState,
  Room,
  RoomEvent,
  Track,
  type AudioCaptureOptions,
  type LocalAudioTrack,
  type RemoteAudioTrack,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication
} from 'livekit-client';
import { createSendProcessor } from '$lib/voice/noiseFilter';
import { NOISE_GATE_DB_DEFAULT } from '$lib/settings-registry/sections/audio';
import { isMobile } from '$lib/platform/runtime';
import { toast } from 'svelte-sonner';
import { m } from '$lib/paraglide/messages.js';
import { istGastKennung } from '$lib/stores/voicePresence.svelte';
import { gastBeitritt, gastVoiceToken, type GastBeitritt, type GastVoiceToken } from './api';

/** Eingehender Ton wird auf dem Desktop mit diesem Faktor verstärkt — dieselbe
 *  Hauslautstärke wie in der Mitglieder-Oberfläche
 *  (``RemoteAudioElements.DEFAULT_MAKEUP_GAIN``). Der Wert ist hier kopiert,
 *  nicht importiert: das Modul schleift räumlichen Klang, Kompressor und
 *  Resonanz-Loader mit, alles Dinge, die eine Gastseite nicht braucht. Ohne
 *  die 4× hört der Gast alle nur „ganz leise" — Mitglieder hören sich
 *  gegenseitig laut, weil ihre Wiedergabe durch denselben Gain läuft. */
const TON_MAKEUP = 4.0;

export type GastVideo = {
  /** LiveKit-Identität des Sendenden (`user-<id>` oder `gast-<id>`). */
  identity: string;
  name: string;
  quelle: 'camera' | 'screen';
  /** ``Track`` statt ``RemoteTrack``: eine Veröffentlichung kann auch die
   *  eigene sein. Angezeigt werden hier zwar nur fremde (die eigene Kamera
   *  malt die Kachel selbst), aber der Typ der Sammlung kennt den
   *  Unterschied nicht. */
  track: Track;
};

export type GastTeilnehmer = {
  identity: string;
  name: string;
  istGast: boolean;
  spricht: boolean;
  stumm: boolean;
};

export type GastPhase = 'vorraum' | 'verbinde' | 'drin' | 'weg';

class GastRaum {
  phase = $state<GastPhase>('vorraum');
  fehler = $state<string | null>(null);
  teilnehmer = $state<GastTeilnehmer[]>([]);
  videos = $state<GastVideo[]>([]);
  mikroStumm = $state(false);
  kameraAn = $state(false);
  beitritt = $state<GastBeitritt | null>(null);
  /** Kamera-Kacheln, die der Gast geöffnet hat (LiveKit-Identities). Wie in
   *  der App: das CAM-Abzeichen an der Teilnehmer-Kachel öffnet die Kachel,
   *  nicht jedes Kamerabild läuft von selbst. */
  kamerasImBlick = $state<string[]>([]);

  /** Eine Kamera-Kachel auf-/zuklappen. */
  kameraImBlickUmschalten(identity: string): void {
    this.kamerasImBlick = this.kamerasImBlick.includes(identity)
      ? this.kamerasImBlick.filter((i) => i !== identity)
      : [...this.kamerasImBlick, identity];
  }

  #room: Room | null = null;
  /** Die eingehängten Ton-Elemente. Eine Menge, keine Karte: gelöst werden
   *  sie über ``track.detach()`` (das gibt seine Elemente selbst zurück),
   *  gebraucht wird die Sammlung nur beim Abbau. Vorher war es eine Karte,
   *  deren Schlüssel beim Setzen und beim Löschen VERSCHIEDEN gebildet wurden
   *  (Rückfall auf die Identität gegen Rückfall auf den leeren Text) — ein
   *  Eintrag, den niemand mehr findet. */
  #audioEls = new Set<HTMLAudioElement>();
  /** Web-Audio-Zug je Ton-Track (Desktop): Quelle → Gain → Ausgabe. Schlüssel
   *  ist die Track-SID; mobil gibt es den Zug nicht, dort ist das
   *  ``<audio>``-Element selbst der hörbare Weg. */
  #tonZuege = new Map<string, { quelle: MediaStreamAudioSourceNode; zug: GainNode }>();
  /** Der AudioContext der Ton-Züge — einer für alle, beim Abbau geschlossen. */
  #tonCtx: AudioContext | null = null;
  /** Das Mikrofon-Track-Objekt, an dem der Rauschfilter hängt (für den Abbau). */
  #mikroTrack: LocalAudioTrack | null = null;
  /** Generationen-Zähler gegen das Destroy/Mount-Race: ein nachlaufender
   *  ``verlassen``-Abschluss einer ALTEN Generation darf ``phase='weg'``
   *  nicht mehr in eine frisch zurückgesetzte Seite schreiben (der Gast sah
   *  sonst die Endseite ohne jeden Wiederkehr-Weg). */
  #generation = 0;
  /** Der eigene Kamera-Track (lokal, ``videos`` trägt ihn bewusst nicht).
   *  Ohne diese Referenz wäre „Kamera an“ für den Gast ein toter Knopf —
   *  er sähe sich selbst nirgends. */
  eigenesVideo = $state<Track | null>(null);
  /** Wird gerufen, wenn die Verbindung endet — egal ob durch Auflegen,
   *  Rauswurf oder Ticket-Ablauf. Die Seite hängt daran das Einstellen der
   *  Stream-Abfrage: ein rausgeworfener Gast fragte sonst weiter im
   *  Fünf-Sekunden-Takt nach und bekäme im Takt ein 403. */
  #beimEnde: (() => void) | null = null;

  beimEnde(rueckruf: (() => void) | null): void {
    this.#beimEnde = rueckruf;
  }

  get ticket(): string | null {
    return this.beitritt?.ticket ?? null;
  }

  /** Den Zustand für einen frischen Besuch zurücksetzen.
   *
   * Der Raum ist ein Modul-Singleton und überlebt damit den Wechsel der
   * Seite. Ohne dieses Zurücksetzen sähe ein Gast, der die Besprechung
   * verlassen hat und den Link erneut öffnet, weiterhin die Endseite —
   * der Zustand ``weg`` bliebe stehen, obwohl er gerade neu ankommt.
   * Dasselbe gilt für eine stehengebliebene Fehlermeldung.
   */
  zuruecksetzen(): void {
    this.#generation += 1; // in-flight ``verlassen``-Abschlüsse entwerten
    if (this.#room) return; // eine laufende Verbindung nicht wegräumen
    this.phase = 'vorraum';
    this.fehler = null;
    this.beitritt = null;
    this.teilnehmer = [];
    this.videos = [];
    this.mikroStumm = false;
    this.kameraAn = false;
    this.kamerasImBlick = [];
    this.eigenesVideo = null;
  }

  async beitreten(code: string, name: string): Promise<void> {
    this.phase = 'verbinde';
    this.fehler = null;
    try {
      const b = await gastBeitritt(code, name);
      this.beitritt = b;
      let tok: GastVoiceToken;
      try {
        tok = await gastVoiceToken(b.ticket, b.channel_id);
      } catch (e) {
        // Halb-Beitritt: das Ticket existiert serverseitig, aber der Gast
        // kann es nie benutzen (kein Voice-Token). Ohne dieses Aufräumen
        // bliebe es als „Belegung“ bis zum Ablauf liegen und eine Wiederholung
        // stieß eher an das Volllimit.
        this.beitritt = null;
        throw e;
      }
      const room = new Room({
        adaptiveStream: true,
        dynacast: true,
        audioCaptureDefaults: this.#aufnahmeVorgaben()
      });
      this.#room = room;
      this.#verdrahten(room);
      await room.connect(tok.ws_url, tok.token);
      await room.localParticipant.setMicrophoneEnabled(true, this.#aufnahmeVorgaben());
      await this.#rauschfilterInstallieren(room);
      this.phase = 'drin';
      this.#auffrischen();
    } catch (e) {
      // Der Beitritt ist der einzige Punkt, an dem der Gast überhaupt etwas
      // tun kann. Scheitert er, muss der Grund stehenbleiben — zurück in den
      // Vorraum, mit Text.
      this.fehler = (e as Error).message || 'fehler';
      this.phase = 'vorraum';
      await this.#abbauen();
    }
  }

  async verlassen(): Promise<void> {
    const generation = this.#generation;
    await this.#abbauen();
    if (generation !== this.#generation) {
      // Ein ``zuruecksetzen`` (frischer Seitenaufruf) ist dazwischen gewesen —
      // die alte Generation schreibt ``weg`` nicht mehr hinein. ABER: jenes
      // Zuruecksetzen lief am ``#room``-Guard leer, weil der Teardown noch
      // lief — es wird JETZT nachgeholt, sonst bliebe der Gast in einer
      // leeren 'drin'-Ansicht ohne Weg zurück.
      this.zuruecksetzen();
      return;
    }
    this.phase = 'weg';
    this.#beimEnde?.();
  }

  async mikroUmschalten(): Promise<void> {
    const lp = this.#room?.localParticipant;
    if (!lp) return;
    const an = this.mikroStumm; // stumm → jetzt einschalten
    try {
      await lp.setMicrophoneEnabled(an);
      this.mikroStumm = !an;
    } catch {
      // Gerät weggezogen / OS-Berechtigung entzogen: der Knopf darf nicht
      // still scheitern — der Gast denkt, es sei „kaputt“.
      toast.error(m.gast_geraet_fehler());
    }
  }

  async kameraUmschalten(): Promise<void> {
    const lp = this.#room?.localParticipant;
    if (!lp) return;
    const neu = !this.kameraAn;
    try {
      await lp.setCameraEnabled(neu);
      this.kameraAn = neu;
    } catch {
      toast.error(m.gast_geraet_fehler());
    }
  }

  async #abbauen(): Promise<void> {
    this.kamerasImBlick = [];
    this.eigenesVideo = null;
    const mikro = this.#mikroTrack;
    this.#mikroTrack = null;
    if (mikro) {
      try {
        await mikro.stopProcessor();
      } catch {
        // Kein Prozessor installiert (Rauschfilter scheiterte beim Beitritt) —
        // dann gibt es beim Abbau auch nichts zu stoppen.
      }
    }
    for (const el of this.#audioEls) el.remove();
    this.#audioEls.clear();
    for (const { quelle, zug } of this.#tonZuege.values()) {
      try {
        quelle.disconnect();
      } catch {
        /* sitzt schon lösen */
      }
      try {
        zug.disconnect();
      } catch {
        /* sitzt schon lösen */
      }
    }
    this.#tonZuege.clear();
    if (this.#tonCtx) {
      void this.#tonCtx.close().catch(() => undefined);
      this.#tonCtx = null;
    }
    this.videos = [];
    this.teilnehmer = [];
    const room = this.#room;
    this.#room = null;
    if (room) {
      try {
        await room.disconnect();
      } catch {
        // Beim Verlassen ist ein fehlgeschlagener Abbau folgenlos: die
        // Verbindung stirbt so oder so, und der Gast sieht schon die Endseite.
      }
    }
  }

  /** Mikrofon-Aufnahme wie bei den Mitgliedern: Browser-Rauschunterdrückung
   *  AUS (die legt sich mit RNNoise in die Quere), Echo-Schutz an, kein AGC. */
  #aufnahmeVorgaben(): AudioCaptureOptions {
    return {
      autoGainControl: false,
      echoCancellation: true,
      noiseSuppression: false,
      channelCount: 1
    };
  }

  /** Denselben Send-Klang wie die Mitglieder: RNNoise + Rauschtor auf dem
   *  Mikrofon-Track installieren. member default (``noiseSuppression:
   *  'rnnoise_gated'``, Tor bei -45 dB). Scheitert der Prozessor (WASM
   *  nicht geladen, Track schon weg), fällt die Aufnahme auf die
   *  Browser-Unterdrückung zurück — roh senden wäre schlechter als halb gut.
   */
  async #rauschfilterInstallieren(room: Room): Promise<void> {
    const pub = room.localParticipant.getTrackPublication(Track.Source.Microphone);
    const track = pub?.audioTrack;
    if (!track) return;
    try {
      const handle = createSendProcessor('rnnoise_gated', NOISE_GATE_DB_DEFAULT, 1);
      await track.setProcessor(handle.processor);
      this.#mikroTrack = track;
    } catch {
      try {
        await room.localParticipant.setMicrophoneEnabled(true, {
          noiseSuppression: true
        });
      } catch {
        // Die Verbindung bleibt trotzdem bestehen — nur eben ungefiltert.
      }
    }
  }

  #verdrahten(room: Room): void {
    const aktiv = (): boolean => this.#room === room;
    room
      .on(RoomEvent.ParticipantConnected, () => aktiv() && this.#auffrischen())
      .on(RoomEvent.ParticipantDisconnected, () => aktiv() && this.#auffrischen())
      .on(RoomEvent.ActiveSpeakersChanged, () => aktiv() && this.#auffrischen())
      .on(RoomEvent.TrackMuted, () => aktiv() && this.#auffrischen())
      .on(RoomEvent.TrackUnmuted, () => aktiv() && this.#auffrischen())
      .on(RoomEvent.ConnectionStateChanged, (s: ConnectionState) => {
        if (!aktiv()) return;
        if (s === ConnectionState.Disconnected) {
          // Der Server hat die Verbindung beendet — bei einem Gast heisst das
          // fast immer: rausgeworfen oder Ticket abgelaufen. Beides ist
          // endgültig, es gibt nichts, worauf man warten könnte.
          void this.#abbauen();
          this.phase = 'weg';
          this.#beimEnde?.();
        }
      })
      .on(
        RoomEvent.TrackSubscribed,
        (track: RemoteTrack, _pub: RemoteTrackPublication, p: RemoteParticipant) => {
          if (!aktiv()) return;
          if (track.kind === Track.Kind.Audio) {
            this.#tonAnhaengen(track as RemoteAudioTrack);
          }
          this.#auffrischen();
        }
      )
      .on(RoomEvent.LocalTrackPublished, (pub) => {
        // Erstveröffentlichung feuert NUR dieses Ereignis (kein TrackSub-
        // scribed — das gibt es nur für Remote-Tracks). Ohne diesen Zweig
        // bliebe ``eigenesVideo`` beim ersten „Kamera an“ null, bis ein
        // beliebiges anderes Ereignis eine Auffrischung auslöst.
        if (!aktiv()) return;
        if (pub.source === Track.Source.Camera) {
          this.eigenesVideo = pub.track ?? null;
        }
      })
      .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
        if (!aktiv()) return;
        // ``detach()`` ohne Argument löst ALLE Elemente dieses Tracks und
        // gibt sie zurück — mehr braucht es nicht.
        for (const el of track.detach()) {
          el.remove();
          this.#audioEls.delete(el as HTMLAudioElement);
        }
        if (track.kind === Track.Kind.Audio) this.#tonLoesen((track as RemoteAudioTrack).sid);
        this.#auffrischen();
      });
  }

  /** Einen eingehenden Ton-Track hörbar machen.
   *
   * Desktop: stummer ``<audio>``-Anker hält den Decoder am Laufen, hörbar
   * ist der Web-Audio-Zug mit dem 4×-Make-up — dieselbe Hauslautstärke, die
   * Mitglieder über ``RemoteAudioElements`` bekommen. Der direkte Weg
   * (Element bei Volume 1) ließ den Gast die Besprechung wie halblaut
   * erleben. Mobil bleibt es beim Element: ``volume`` geht dort nicht über
   * 1 hinaus, dafür spielt es weiter, wenn der Bildschirm sperriert. */
  #tonAnhaengen(track: RemoteAudioTrack): void {
    const el = track.attach() as HTMLAudioElement;
    el.autoplay = true;
    el.style.display = 'none';
    document.body.appendChild(el);
    this.#audioEls.add(el);
    if (isMobile()) return;
    el.muted = true;
    const mst = track.mediaStreamTrack;
    if (!mst) return;
    const ctx = this.#tonKontext();
    const quelle = ctx.createMediaStreamSource(new MediaStream([mst]));
    const zug = ctx.createGain();
    zug.gain.value = TON_MAKEUP;
    quelle.connect(zug);
    zug.connect(ctx.destination);
    const sid = track.sid;
    if (sid) this.#tonZuege.set(sid, { quelle, zug });
  }

  #tonKontext(): AudioContext {
    if (!this.#tonCtx || this.#tonCtx.state === 'closed') {
      this.#tonCtx = new AudioContext();
    }
    if (this.#tonCtx.state === 'suspended') {
      void this.#tonCtx.resume().catch(() => undefined);
    }
    return this.#tonCtx;
  }

  #tonLoesen(sid: string | undefined): void {
    if (!sid) return;
    const zug = this.#tonZuege.get(sid);
    if (!zug) return;
    try {
      zug.quelle.disconnect();
    } catch {
      /* sitzt schon lösen */
    }
    try {
      zug.zug.disconnect();
    } catch {
      /* sitzt schon lösen */
    }
    this.#tonZuege.delete(sid);
  }

  /** Teilnehmer- und Videoliste aus dem Raum neu bauen.
   *
   * Vollständiger Neuaufbau statt gepflegter Teillisten: die Menge ist bei
   * einer Besprechung klein, und ein Zustand, der nur aus Ereignissen wächst,
   * driftet bei jedem verpassten Ereignis. */
  #auffrischen(): void {
    const room = this.#room;
    if (!room) return;
    const sprecher = new Set(room.activeSpeakers.map((p) => p.identity));
    const liste: GastTeilnehmer[] = [];
    const videos: GastVideo[] = [];
    // Der eigene Kamera-Track wird je Durchlauf neu bestimmt — ausgeschaltete
    // Kamera darf keine stale Referenz hinterlassen.
    this.eigenesVideo = null;
    const alle = [room.localParticipant, ...room.remoteParticipants.values()];
    for (const p of alle) {
      liste.push({
        identity: p.identity,
        name: p.name?.trim() || p.identity,
        istGast: istGastKennung(p.identity),
        spricht: sprecher.has(p.identity),
        stumm: !p.isMicrophoneEnabled
      });
      for (const pub of p.trackPublications.values()) {
        const t = pub.track;
        if (!t || t.kind !== Track.Kind.Video) continue;
        if (p === room.localParticipant) {
          // Die eigene Kamera bewusst NICHT in ``videos`` — aber referenziert:
          // die Ansicht zeigt sie im eigenen Teilnehmer-Knopf, sonst wäre
          // „Kamera an“ nicht prüfbar.
          this.eigenesVideo = pub.source === Track.Source.Camera ? t : this.eigenesVideo;
          continue;
        }
        videos.push({
          identity: p.identity,
          name: p.name?.trim() || p.identity,
          quelle: pub.source === Track.Source.ScreenShare ? 'screen' : 'camera',
          track: t
        });
      }
    }
    this.teilnehmer = liste;
    this.videos = videos;
  }
}

export const gastRaum = new GastRaum();
