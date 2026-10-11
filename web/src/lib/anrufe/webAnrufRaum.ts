/**
 * Der Medienweg über `livekit-client` in der WebView — Browser, Electron,
 * Android und iOS-Bauten ohne nativen Anruf-Raum (`anrufMedien.ts`).
 *
 * Aus `anruf.svelte.ts` herausgelöst (Grössen-Policy, die Datei lag bei 705
 * Zeilen), ohne Verhaltensänderung: dieselben Ereignisse, dieselbe
 * Reihenfolge von Rufmodus, iOS-Session und Verbinden.
 */

import { ConnectionState, ExternalE2EEKeyProvider, Room, RoomEvent, Track } from 'livekit-client';

import { setVoiceActive } from '$lib/platform/audioRoute';
import { tonVoice } from '$lib/platform/iosTon';
import type { AnrufMedien, AnrufMedienHaken, LaufenderAnruf } from './anrufMedien';
import { base64ZuBytes } from './anrufSchluessel';

/** Der E2EE-Worker wird über alle Anrufe wiederverwendet (LiveKit-Muster:
 *  ein Worker, viele Rooms) — Seiten-Lebensdauer, kein Abbau nötig.
 *  Subpfad laut exports-Map dieser Version: `./e2ee-worker` (Bindestrich,
 *  NICHT `e2ee.worker` wie in der LiveKit-Doku). */
let e2eeArbeiter: Worker | null = null;
function e2eeWorker(): Worker {
  return (e2eeArbeiter ??= new Worker(new URL('livekit-client/e2ee-worker', import.meta.url), {
    type: 'module'
  }));
}

export class WebAnrufRaum implements AnrufMedien {
  readonly nativ = false;
  #haken: AnrufMedienHaken;
  #room: Room | null = null;
  /** Von `track.attach()` erzeugte Audio-Elemente — beim Abbau entfernen. */
  #ferneStimmen: HTMLMediaElement[] = [];

  constructor(haken: AnrufMedienHaken) {
    this.#haken = haken;
  }

  async vorbereitenAusgehend(_anruf: LaufenderAnruf): Promise<void> {}

  async vorbereitenAnnahme(_anruf: LaufenderAnruf): Promise<void> {}

  /** Liegt ein Schlüssel zum Anruf (E2EE-Anrufe), wird der Raum mit der
   *  `encryption`-Option gebaut und der Schlüssel VOR `connect()` gesetzt —
   *  ohne Schlüssel (Klartext-Weg) verbindet der Raum wie bisher ohne E2EE. */
  async verbinden(
    _anruf: LaufenderAnruf,
    zugang: { ws_url: string; token: string },
    schluessel: string | null,
    stumm: boolean,
    aktuell: () => boolean
  ): Promise<void> {
    let encryption: { keyProvider: ExternalE2EEKeyProvider; worker: Worker } | undefined;
    if (schluessel !== null) {
      const keyProvider = new ExternalE2EEKeyProvider();
      // ROHE Bytes: livekit-client leitet daraus per HKDF ab. Die native
      // Hülle muss dieselbe Ableitung wählen (`AnrufRaum.swift`) — ein
      // String hier wäre PBKDF2, und ein Gerät mit der anderen Ableitung
      // hörte nur Rauschen.
      await keyProvider.setKey(base64ZuBytes(schluessel));
      // ponytail: LiveKits Frame-Verschlüsselung trägt nur VP8/Opus; der
      // videoCodec läuft schon per Default auf vp8. Upgrade-Pfad: Codecs per
      // Fähigkeit aushandeln, sobald LiveKit mehr beherrscht.
      encryption = { keyProvider, worker: e2eeWorker() };
    }
    const room = new Room(encryption ? { encryption } : undefined);
    if (encryption) await room.setE2EEEnabled(true);
    this.#room = room;
    room
      .on(RoomEvent.ConnectionStateChanged, (s) => {
        if (s === ConnectionState.Connected) {
          this.#haken.verbunden();
        } else if (s === ConnectionState.Disconnected) {
          // LiveKit-Kick oder Netzverlust — früher blieb ein totes Overlay
          // stehen (der Store kannte nur Connected, Befund 03.10.). Eigene
          // Räumung feuert Disconnected erneut → der Raum-Vergleich dämpft.
          if (this.#room === room) this.#haken.verloren();
        }
      })
      .on(RoomEvent.TrackSubscribed, (track) => {
        // Ferne Stimme hörbar machen — LiveKit liefert Track-Objekte,
        // ohne DOM-Anhang bleibt alles stumm (dasselbe Muster wie die
        // Voice-Engine, nur ohne Gain-/Kompressor-Zubehör).
        if (track.kind === Track.Kind.Audio) {
          const element = track.attach();
          // Versteckt an den Body — ein schwebendes Element spielt zwar,
          // ist aber gegen GC-/Pause-Heuristiken einiger Browser unsicher.
          element.hidden = true;
          document.body.appendChild(element);
          this.#ferneStimmen.push(element);
        }
      })
      .on(RoomEvent.ParticipantEncryptionStatusChanged, (aktiv, teilnehmer) => {
        // Das ehrliche Live-Lesezeichen fürs Badge — deckt auch den Fall,
        // dass der Status erst NACH dem Connect-Resolve umschaltet.
        if (teilnehmer?.isLocal && this.#room === room) {
          this.#haken.verschluesselung(aktiv ? 'e2ee' : 'transport', true);
        }
      });

    // Android: MODE_IN_COMMUNICATION VOR room.connect() erzwingen — derselbe
    // Grund wie in `voice/livekit.svelte.ts`: Android pinnt ein laufendes
    // AudioTrack auf seinen Stream; kommt der Modus erst nach dem Handschlag,
    // laufen die Stimmen auf dem Medien-Kanal (falscher Lautstärkeregler,
    // im Auto leises A2DP). So läuft der Anruf über die Anruf-Lautstärke und
    // der Mic-Dienst hält die Verbindung bei gesperrtem Bildschirm am Leben.
    await setVoiceActive(true);
    // **iOS (Bauten ohne nativen Raum): hier fehlte die Audio-Session ganz**
    // (gefunden 2026-10-08 beim Bau von Punkt 40). `setVoiceActive` ist
    // Android-only; den iOS-Weg kannte nur der Sprachkanal, nicht der Anruf.
    //
    // Eigene Kennung, nicht `'sprachkanal'`: Anruf und Kanal laufen
    // unabhängig, und mit einer gemeinsamen Kennung nähme das Auflegen dem
    // Kanal die Session weg (s. `platform/iosTon.ts`).
    //
    // Abgewartet — dieselbe Regel wie im Sprachkanal: Session fertig, dann
    // Mikrofon. Hier stand bis zum 2026-10-10 das Gegenteil, mit der
    // Begründung, der native `setActive` halte den Hauptthread; am Gerät
    // nachgemessen stimmt das nicht (die Zahlen und die wirkliche Ursache
    // stehen bei der Schwesterstelle in `voice/livekit.svelte.ts`).
    await tonVoice('anruf', true);

    await room.connect(zugang.ws_url, zugang.token);
    if (!aktuell()) {
      void room.disconnect();
      return;
    }
    this.#haken.verschluesselung(room.isE2EEEnabled ? 'e2ee' : 'transport', false);
    await room.localParticipant.setMicrophoneEnabled(!stumm);
  }

  async mikrofon(an: boolean): Promise<void> {
    await this.#room?.localParticipant.setMicrophoneEnabled(an);
  }

  async kamera(an: boolean): Promise<void> {
    await this.#room?.localParticipant.setCameraEnabled(an);
  }

  async ausgabe(_lautsprecher: boolean): Promise<void> {}

  trennen(): void {
    const room = this.#room;
    this.#room = null;
    if (room) void room.disconnect();
    // `room.disconnect()` trennt die Tracks, aber die angehängten Elemente
    // bleiben als Medienreste im DOM — hier weg damit.
    for (const element of this.#ferneStimmen) element.remove();
    this.#ferneStimmen = [];
    // Android: Ruf-Modus + Mic-Dienst freigeben (No-op außerhalb des Wrappers) —
    // sonst bleibt das Telefon im Call-Modus hängen (falscher Lautstärkeregler).
    void setVoiceActive(false);
    void tonVoice('anruf', false);
  }
}
