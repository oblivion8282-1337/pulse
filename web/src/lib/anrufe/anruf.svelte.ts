/**
 * Der Anruf-Zustand (Übergabe P0, Anrufe-Epic C+D) — EINE Sitzung, ein
 * Gleichzeitiger Anruf pro Fenster. Bewusst EIGENE LiveKit-Verbindung
 * neben der Voice-Engine: die Engine ist an Guild-Kanäle gekoppelt
 * (Presence, Bitrate, Resume, Guild-Lookups), ein Anruf hätte davon
 * nichts — der dünne Parallelweg ist weniger riskant als ein dritter
 * Modus in `livekit.svelte.ts`.
 *
 * Ablauf 1:1: `starten` → klingelt (WS an die Gegenseite) → Annahme
 * (`call_angenommen`) → beide verbinden ihren Raum → Auflegen/Ende
 * (`call_ende`) räumt überall ab. 45 s ohne Annahme: der Rufende bricht
 * ab (serverseitig „verpasst“), der Angerufene lehnt automatisch ab.
 *
 * E2EE (2026-09-09): bei E2EE-fähigem Ziel (verschlüsselte DM bzw. private
 * Gruppe) erzeugt der Initiator EINEN LiveKit-E2EE-Schlüssel (32
 * Zufallsbytes) und verschickt ihn als Anruf-Schlüssel-Frame über das
 * verschlüsselte Postfach (`krypto/senden.ts` bzw. `krypto/gruppe/
 * frameSenden.ts`) — misslingt die Zustellung, bricht der Anruf ab
 * (fail-closed, kein unverschlüsselter Anruf). Der Angerufene wartet nach
 * der Annahme auf den Schlüssel (`schluesselWarten.ts`), bevor er mit der
 * `encryption`-Room-Option verbindet; Schlüssel liegen NUR im
 * Arbeitsspeicher dieser Map. Klartext-DMs (Schalter aus) laufen wie bisher
 * ohne Schlüssel — transportverschlüsselt, ehrlich im Overlay benannt.
 */

import { ConnectionState, Room, RoomEvent, Track, ExternalE2EEKeyProvider } from 'livekit-client';
import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { isCapacitorAndroid } from '$lib/platform/runtime';
import {
  anrufAnnehmen,
  anrufAblehnen,
  anrufAuflegen,
  anrufStarten,
  getAnrufToken,
  type AnrufArt
} from '$lib/api/anrufe';
import { sounds } from '$lib/sounds/engine';
import { toast } from 'svelte-sonner';
import { formatiereDauer } from '$lib/attachments/aufnahmeKern';
import { m } from '$lib/paraglide/messages.js';
import { anrufSystemzeile, type AnrufZeilenSchluessel } from './systemzeileKern';
import { warteAufAnrufSchluessel } from './schluesselWarten';
import { E2E_DMS_ENABLED, PRIVATE_GRUPPEN_ENABLED } from '$lib/krypto/schalter';

const KLINGEL_TIMEOUT_MS = 45_000;

/** E2EE-fähiges Ziel? Bei DMs entscheidet der DM-Schalter, bei Gruppen der
 *  Gruppen-Schalter — ist einer aus, gibt es dort schlicht keinen
 *  verschlüsselten Weg (Klartext-DM), und der Anruf läuft ohne Schlüssel. */
function e2eeFaehig(art: AnrufArt): boolean {
  return art === 'gruppe' ? PRIVATE_GRUPPEN_ENABLED : E2E_DMS_ENABLED;
}

/** Frischer Anruf-Schlüssel: 32 Zufallsbytes, base64. */
function neuAnrufSchluessel(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binär = '';
  for (const b of bytes) binär += String.fromCharCode(b);
  return btoa(binär);
}

/** base64 → ArrayBuffer (für `keyProvider.setKey`). */
function base64ZuBytes(wert: string): ArrayBuffer {
  const binär = atob(wert);
  const bytes = new Uint8Array(binär.length);
  for (let i = 0; i < binär.length; i++) bytes[i] = binär.charCodeAt(i);
  return bytes.buffer;
}

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

/**
 * Native Brücke (nur im Capacitor-Android-APK, s. mobile/android …/AnrufPlugin.java,
 * Anrufe-Epic E): eingehende Anrufe zeigen eine Full-Screen-Intent-Notification
 * über dem Sperrbildschirm; Annehmen/Ablehnen aus der Notification kommen als
 * `aktion`-Event zurück, weil die Signalisierung (anrufAnnehmen/anrufAblehnen)
 * im Klienten lebt. In Browser/Electron No-op.
 */
interface AnrufNativPlugin {
  ankommen(opts: { callId: string; gegenstelle: string }): Promise<void>;
  beenden(): Promise<void>;
  addListener(
    event: 'aktion',
    cb: (data: { aktion: 'annehmen' | 'ablehnen'; callId: string }) => void
  ): Promise<PluginListenerHandle>;
}

const anrufNativ = registerPlugin<AnrufNativPlugin>('Anruf');

/** Klingel-Notification nativ zeigen (No-op außerhalb des Android-Wrappers). */
async function nativAnkommen(callId: string, gegenstelle: string): Promise<void> {
  if (!isCapacitorAndroid()) return;
  try {
    await anrufNativ.ankommen({ callId, gegenstelle });
  } catch (e) {
    console.warn('[anruf] native Klingel-Anzeige fehlgeschlagen', e);
  }
}

/** Klingel-Notification nativ entfernen (No-op außerhalb des Android-Wrappers). */
async function nativBeenden(): Promise<void> {
  if (!isCapacitorAndroid()) return;
  try {
    await anrufNativ.beenden();
  } catch (e) {
    console.warn('[anruf] native Klingel-Anzeige entfernen fehlgeschlagen', e);
  }
}

type Rolle = 'ausgehend' | 'eingehend';

type LaufenderAnruf = {
  id: string;
  art: AnrufArt;
  channel_id: string;
  rolle: Rolle;
  gegenstelle: string;
  zustand: 'klingelt' | 'verbunden';
};

class AnrufStore {
  aktiv = $state<LaufenderAnruf | null>(null);
  stumm = $state(false);
  kameranAn = $state(false);
  /** Sekunden seit Annahme — der Ticker der Overlay-UI. */
  dauerSekunden = $state(0);
  /** Overlay-Badge (E2EE-Anrufe): 'e2ee' = Ende-zu-Ende (gelesen aus
   *  `room.isE2EEEnabled`), 'transport' = Klartext-Weg, `null` = kein Anruf
   *  / noch nicht verbunden. */
  verschluesselung = $state<'e2ee' | 'transport' | null>(null);
  /** Overlay-Hinweis während der Angerufene auf den Schlüssel wartet. */
  schluesselWarten = $state(false);

  #room: Room | null = null;
  #klingelWecker: ReturnType<typeof setTimeout> | null = null;
  #dauerTimer: ReturnType<typeof setInterval> | null = null;
  /** Von `track.attach()` erzeugte Audio-Elemente — beim Abbau entfernen. */
  #ferneStimmen: HTMLMediaElement[] = [];
  /** In einem WS-Handler gesetzte Endes-Info für das gerade Abgebaute. */
  #abbauGen = 0;
  /** Anruf-Schlüssel (E2EE-Anrufe), NUR im Arbeitsspeicher — `anrufId →
   *  base64`. Gefüllt vom Empfangs-Dispatch (`empfangen.ts::schluessel-
   *  Empfangen`) und vom Initiator in `starten`.
   *  ponytail: Einträge von Anrufen, die dieses Gerät nie führte (fremde
   *  Gruppenanrufe, eigenes Zweitgerät), bleiben bis zum Seitenende stehen —
   *  je Eintrag 32 Bytes; Aufräumen per Altersliste wäre der Ausbau, falls
   *  das je sichtbar wird. */
  #schluessel = new Map<string, string>();
  /** Vom WS-Bootstrap angedockte Senke für die Chat-Systemzeile — Injektion
   *  statt Import (`systemzeileSenden.ts`), sonst zirkelt die Sendekette. */
  #zeilenZiel:
    | ((kanalId: string, schluessel: AnrufZeilenSchluessel, dauerSek: number) => void)
    | null = null;
  /** Schon eine Zeile für den LAUFENDEN Anruf hinterlassen? `ende()` und der
   *  lokale Abbau können sich im Wettlauf doppelt melden. */
  #systemzeileErledigt = false;

  get inAnruf(): boolean {
    return this.aktiv !== null;
  }

  /** Vom WS-Bootstrap: dockt die Senke an, die die Systemzeile sendet. */
  zeilenZielSetzen(
    ziel: (kanalId: string, schluessel: AnrufZeilenSchluessel, dauerSek: number) => void
  ): void {
    this.#zeilenZiel = ziel;
  }

  /** Vom Empfangs-Dispatch (`empfangen.ts`, art 'anrufSchluessel'): den
   *  Schlüssel eines Anrufs merken — fail-closed, nur sauber dekodierbare
   *  32-Byte-Schlüssel; alles andere wird verworfen, statt einen halben
   *  Schlüssel an LiveKit zu reichen. */
  schluesselEmpfangen(anrufId: string, schluessel: string): void {
    if (anrufId === '' || schluessel === '') return;
    try {
      if (base64ZuBytes(schluessel).byteLength !== 32) return;
    } catch {
      return; // kein base64
    }
    this.#schluessel.set(anrufId, schluessel);
  }

  async starten(art: AnrufArt, channelId: string, gegenstelle: string): Promise<void> {
    if (this.aktiv) return;
    // E2EE-fähiges Ziel: Schlüssel JETZT erzeugen — die ID des Anrufs kennt
    // erst der Server, der Schlüsselinhalt kommt vom Initiator.
    const schluessel = e2eeFaehig(art) ? neuAnrufSchluessel() : null;
    // Sync-Platzhalter schließt das Doppelklick-Fenster vor dem await.
    this.aktiv = { id: '', art, channel_id: channelId, rolle: 'ausgehend', gegenstelle, zustand: 'klingelt' };
    this.#systemzeileErledigt = false;
    try {
      const angabe = await anrufStarten(art, channelId);
      this.aktiv = {
        id: angabe.id,
        art,
        channel_id: channelId,
        rolle: 'ausgehend',
        gegenstelle,
        zustand: 'klingelt'
      };
      if (schluessel !== null) {
        this.#schluessel.set(angabe.id, schluessel);
        try {
          await this.#schluesselVerteilen(art, channelId, angabe.id, schluessel);
        } catch (e) {
          // Fail-closed: ohne zugestellten Schlüssel keinen Anruf — der WS-
          // Ruf ist durch den POST schon draußen, also den Server-Anruf
          // beenden (sonst klingelt die Gegenseite ins Leere), dann abbrechen.
          toast.error(m.anruf_schluessel_senden_fehlgeschlagen(), {
            description: e instanceof Error ? e.message : undefined
          });
          void anrufAuflegen(angabe.id).catch(() => {});
          this.#aufräumen();
          return;
        }
      }
    } catch (e) {
      this.#aufräumen();
      throw e;
    }
    this.#klingelWeckerPlanen();
  }

  /** Schlüssel-Umschlag an alle Geräte verteilen — DM per Olm, Gruppe per
   *  Megolm. Dynamisch importiert (Muster wie `systemzeileSenden`): die
   *  Sendekette zieht den halben Krypto-Stack nach sich, und der Store lädt
   *  sie erst, wenn wirklich verschickt wird. Wirft, wenn nichts zugestellt
   *  wurde — der Aufrufer bricht den Anruf ab. */
  async #schluesselVerteilen(
    art: AnrufArt,
    kanalId: string,
    anrufId: string,
    schluessel: string
  ): Promise<void> {
    const nichtZustellbar = () => new Error('Anruf-Schlüssel nicht zustellbar');
    if (art === 'gruppe') {
      const { sendeGruppenAnrufSchluessel } = await import('$lib/krypto/gruppe/frameSenden');
      if (!(await sendeGruppenAnrufSchluessel(kanalId, anrufId, schluessel))) {
        throw nichtZustellbar();
      }
      return;
    }
    const { directMessages } = await import('$lib/stores/directMessages.svelte');
    const empfaenger = directMessages.byId[kanalId]?.other_user_id;
    if (!empfaenger) throw nichtZustellbar();
    const { sendeAnrufSchluessel } = await import('$lib/krypto/senden');
    if (!(await sendeAnrufSchluessel(kanalId, empfaenger, anrufId, schluessel))) {
      throw nichtZustellbar();
    }
  }

  /** Eingehender Ruf aus dem WS-Event `call_klingelt` — der Name der
   *  Gegenstelle löst der Handler über den Nutzer-Cache auf. */
  eingehend(
    evt: { call_id: string; art: string; channel_id: string; einleiter_id: string },
    gegenstelle: string
  ): void {
    // Dieselbe Lieferung kann über beide Verbindungen kommen (Hintergrund-
    // Cloud + aktiv) — ein zweiter Lauf desselben call_id darf nichts tun,
    // sonst lehnt der Client sich selbst weg und der Anruf stirbt nach
    // der Annahme (Feldbefund 2026-09-08).
    if (this.aktiv?.id === evt.call_id) return;
    if (this.aktiv) {
      // Wirklich ein anderer Anruf → lehne automatisch ab, statt zu stapeln.
      void anrufAblehnen(evt.call_id).catch(() => {});
      return;
    }
    this.aktiv = {
      id: evt.call_id,
      art: evt.art as AnrufArt,
      channel_id: evt.channel_id,
      rolle: 'eingehend',
      gegenstelle,
      zustand: 'klingelt'
    };
    this.#systemzeileErledigt = false;
    sounds.play('notification.dm');
    this.#klingelWeckerPlanen();
    // Sperrbildschirm (Anrufe-Epic E): nativ Full-Screen-Notification zeigen.
    void nativAnkommen(evt.call_id, gegenstelle);
  }

  /** Die Gegenseite hat den Namen ins Overlay getragen (vom Klienten des
   *  Anrufers gesetzt; beim Angerufenen weiß der Store ihn nicht). */
  #setGegenstelle(name: string): void {
    if (this.aktiv) this.aktiv = { ...this.aktiv, gegenstelle: name };
  }

  async annehmen(gegenstelle: string): Promise<void> {
    const anruf = this.aktiv;
    if (!anruf || anruf.rolle !== 'eingehend') return;
    this.#setGegenstelle(gegenstelle);
    this.#klingelWeckerLoeschen();
    try {
      await anrufAnnehmen(anruf.id);
      if (e2eeFaehig(anruf.art)) {
        // Postfach-Abholung anstoßen (bestehender Einstiegspunkt, dynamisch
        // importiert — der WS-Weckruf `postfach_neu` hat sie meist schon
        // angestoßen; hier doppelt sich nichts, der Nachlauf dedupliziert),
        // dann fail-closed auf den Schlüssel warten.
        void import('$lib/krypto/empfangen')
          .then(({ postfachAbholenUndEntschluesseln }) => postfachAbholenUndEntschluesseln())
          .catch(() => {});
        this.schluesselWarten = true;
        const schluessel = await warteAufAnrufSchluessel(
          () => this.#schluessel.get(anruf.id) ?? null
        );
        this.schluesselWarten = false;
        if (this.aktiv?.id !== anruf.id) return; // inzwischen beendet — Abbau lief
        if (schluessel === null) {
          // Kein Schlüssel, kein Anruf — NICHT unverschlüsselt weitermachen.
          toast.error(m.anruf_schluessel_fehlt());
          void anrufAuflegen(anruf.id).catch(() => {});
          this.#aufräumen();
          return;
        }
      }
      await this.#verbinden();
      // Klingel-Notification weg — das Overlay übernimmt.
      void nativBeenden();
    } catch (e) {
      // Annahme fehlgeschlagen (Anruf inzwischen vorbei?) — sauber abräumen.
      toast.error(m.anruf_aktion_fehlgeschlagen(), {
        description: e instanceof Error ? e.message : undefined
      });
      this.#aufräumen();
    }
  }

  async ablehnen(): Promise<void> {
    const anruf = this.aktiv;
    if (!anruf) return;
    this.#klingelWeckerLoeschen();
    if (anruf.rolle === 'eingehend') {
      try {
        await anrufAblehnen(anruf.id);
      } catch {
        // Der Server hat den Anruf vielleicht schon beendet — egal, lokal ist
        // aufgeräumt; das Ende kam oder kommt als `call_ende` ohnehin.
      }
    }
    this.#aufräumen();
  }

  async auflegen(): Promise<void> {
    const anruf = this.aktiv;
    if (!anruf) return;
    // Klingelt der Anruf noch, stuft der Server das Auflegen als „verpasst“
    // ein (routes/anrufe.py) — dieselbe Einstufung für die eigene Zeile.
    this.#systemzeileHinterlassen(
      anruf.zustand === 'klingelt' ? 'verpasst' : 'aufgelegt',
      anruf.zustand === 'klingelt' ? 0 : this.dauerSekunden
    );
    this.#klingelWeckerLoeschen();
    try {
      await anrufAuflegen(anruf.id);
    } catch {
      // Anruf war schon vorbei — der lokale Abbau zählt.
    }
    this.#aufräumen();
  }

  async stummUmschalten(): Promise<void> {
    if (!this.#room) return;
    this.stumm = !this.stumm;
    await this.#room.localParticipant.setMicrophoneEnabled(!this.stumm);
  }

  async kameraUmschalten(): Promise<void> {
    const room = this.#room;
    if (!room) return;
    this.kameranAn = !this.kameranAn;
    await room.localParticipant.setCameraEnabled(this.kameranAn);
  }

  /** Vom WS-Handler: Initiator stoppt Klingeln und verbindet. */
  verbindenNachAnnahme(callId: string): void {
    const anruf = this.aktiv;
    if (!anruf || anruf.id !== callId || anruf.rolle !== 'ausgehend') return;
    this.#klingelWeckerLoeschen();
    void this.#verbinden();
  }

  /** Vom WS-Handler: `call_abgelehnt` beim Rufenden — UI-Info, das Ende
   *  kommt als `call_ende` vom Server (1:1) bzw. als weiteres Klingeln
   *  (Gruppe). */
  gegenstelleAbgelehnt(): void {
    if (this.aktiv?.rolle === 'ausgehend') {
      toast.info(m.anruf_wurde_abgelehnt());
    }
  }

  /** Vom WS-Handler: `call_ende` — überall abbauen, Grund kurz zeigen. */
  ende(callId: string, grund: string, dauerSek: number): void {
    const anruf = this.aktiv;
    if (!anruf || anruf.id !== callId) return;
    this.#systemzeileHinterlassen(grund, dauerSek);
    this.#aufräumen();
    if (anruf.rolle === 'eingehend' && grund === 'verpasst') {
      toast.error(m.anruf_verpasst());
    } else if (grund === 'aufgelegt' && dauerSek > 0) {
      toast.info(m.anruf_beendet_dauer({ dauer: formatiereDauer(dauerSek) }));
    }
  }

  #klingelWeckerPlanen(): void {
    this.#klingelWeckerLoeschen();
    this.#klingelWecker = setTimeout(() => {
      // Sicherheitskipphebel: ein verspäteter Wecker darf nur noch dann
      // handeln, wenn der Anruf IMMER NOCH klingelt — niemals einen
      // verbundenen Anruf totlegen (Feldbefund 2026-09-08).
      if (this.aktiv?.zustand !== 'klingelt') return;
      if (this.aktiv.rolle === 'ausgehend') void this.auflegen();
      else void this.ablehnen();
    }, KLINGEL_TIMEOUT_MS);
  }

  #klingelWeckerLoeschen(): void {
    if (this.#klingelWecker) {
      clearTimeout(this.#klingelWecker);
      this.#klingelWecker = null;
    }
  }

  /** Grund und Dauer sind bekannt → einmalig die Chat-Zeile anstoßen. Ob und
   *  was, rechnet `systemzeileKern.ts` (nur 1:1, nur der Einleiter); ohne
   *  angedockte Senke (Tests, vor dem Bootstrap) bleibt es beim lokalen
   *  Abbau. */
  #systemzeileHinterlassen(grund: string, dauerSek: number): void {
    const anruf = this.aktiv;
    if (!anruf || this.#systemzeileErledigt) return;
    const zeile = anrufSystemzeile(anruf.art, anruf.rolle, grund, dauerSek);
    if (!zeile) return;
    this.#systemzeileErledigt = true;
    this.#zeilenZiel?.(anruf.channel_id, zeile.schluessel, zeile.dauerSek);
  }

  /** LiveKit-Raum betreten — Token von voice-signaling, Room-Name vom Server.
   *  Liegt ein Schlüssel zum Anruf (E2EE-Anrufe), wird der Raum mit der
   *  `encryption`-Option gebaut und der Schlüssel VOR `connect()` gesetzt —
   *  ohne Schlüssel (Klartext-Weg) verbindet der Raum wie bisher ohne E2EE. */
  async #verbinden(): Promise<void> {
    const anruf = this.aktiv;
    if (!anruf) return;
    const schluessel = this.#schluessel.get(anruf.id) ?? null;
    const gen = ++this.#abbauGen;
    try {
      const resp = await getAnrufToken(anruf.id);
      if (gen !== this.#abbauGen) return; // inzwischen abgebaut
      let encryption: { keyProvider: ExternalE2EEKeyProvider; worker: Worker } | undefined;
      if (schluessel !== null) {
        const keyProvider = new ExternalE2EEKeyProvider();
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
            this.aktiv = this.aktiv ? { ...this.aktiv, zustand: 'verbunden' } : null;
            this.#dauerTimerStarten();
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
            this.verschluesselung = aktiv ? 'e2ee' : 'transport';
          }
        });

      await room.connect(resp.ws_url, resp.token);
      if (gen !== this.#abbauGen) {
        void room.disconnect();
        return;
      }
      if (this.verschluesselung === null) {
        this.verschluesselung = room.isE2EEEnabled ? 'e2ee' : 'transport';
      }
      await room.localParticipant.setMicrophoneEnabled(!this.stumm);
    } catch (e) {
      if (gen !== this.#abbauGen) return;
      toast.error(m.anruf_verbindung_fehlgeschlagen(), {
        description: e instanceof Error ? e.message : undefined
      });
      this.#aufräumen();
    }
  }

  #dauerTimerStarten(): void {
    this.dauerSekunden = 0;
    this.#dauerTimer = setInterval(() => {
      this.dauerSekunden += 1;
    }, 1000);
  }

  /** Lokaler Abbau — Room, Ticker, Zustand. Der Server-POST passiert
   *  getrennt (auflegen/ablehnen), damit Fehler hier nicht hängen bleiben. */
  #aufräumen(): void {
    // Klingel-Notification auf dem Sperrbildschirm entfernen — deckt ablehnen,
    // auflegen, call_ende, Klingel-Timeout und Annahme-Fehlschlag ab.
    void nativBeenden();
    this.#abbauGen++;
    // Auch der Klingel-Wecker gehört zum Aufräumen — sonst feuert der Wecker
    // eines beendeten Anrufs in den NÄCHSTEN hinein und legt ihn still weg.
    this.#klingelWeckerLoeschen();
    if (this.#dauerTimer) {
      clearInterval(this.#dauerTimer);
      this.#dauerTimer = null;
    }
    const room = this.#room;
    this.#room = null;
    this.stumm = false;
    this.kameranAn = false;
    this.dauerSekunden = 0;
    this.schluesselWarten = false;
    this.verschluesselung = null;
    if (this.aktiv) this.#schluessel.delete(this.aktiv.id);
    this.aktiv = null;
    if (room) void room.disconnect();
    // `room.disconnect()` trennt die Tracks, aber die angehängten Elemente
    // bleiben als Medienreste im DOM — hier weg damit.
    for (const element of this.#ferneStimmen) element.remove();
    this.#ferneStimmen = [];
  }
}

export const anrufe = new AnrufStore();

// Annehmen/Ablehnen aus der nativen Sperrbildschirm-Notification (feuert nur
// unter Capacitor-Android). Fremde oder abgelaufene callIds (verspäteter Tap
// auf eine alte Klingel-Notification) werden ignoriert.
// Guard ist PFLICHT: der Web-Stub von registerPlugin wirft beim addListener
// ("not implemented on web") und riss sonst das komplette Boot mit — die
// Login-Seite blieb im Browser weiß (Befund 2026-09-09).
if (isCapacitorAndroid()) {
  void anrufNativ.addListener('aktion', ({ aktion, callId }) => {
    const anruf = anrufe.aktiv;
    if (!anruf || anruf.id !== callId) return;
    if (aktion === 'annehmen') void anrufe.annehmen(anruf.gegenstelle);
    else void anrufe.ablehnen();
  });
}
