/**
 * Der Anruf-Zustand (Übergabe P0, Anrufe-Epic C+D) — EINE Sitzung, ein
 * gleichzeitiger Anruf pro Fenster.
 *
 * Ablauf 1:1: `starten` → klingelt (WS an die Gegenseite) → Annahme
 * (`call_angenommen`) → beide verbinden ihren Raum → Auflegen/Ende
 * (`call_ende`) räumt überall ab. 45 s ohne Annahme: der Rufende bricht
 * ab (serverseitig „verpasst“), der Angerufene lehnt automatisch ab.
 *
 * E2EE (2026-09-09): der Initiator erzeugt einen Anruf-Schlüssel und
 * verschickt ihn über das verschlüsselte Postfach, der Angerufene wartet
 * nach der Annahme darauf — fail-closed, beide Hälften in
 * `anrufSchluesselweg.ts`.
 *
 * **Hier steht nur die Signalisierung.** Die Medienseite (eigene
 * LiveKit-Verbindung, Knöpfe, Dauer, Verschlüsselung, die Übernahme nach
 * einem Reload) erbt die Klasse von `AnrufMedienZustand`
 * (`anrufMedienZustand.svelte.ts`).
 */

import type { AnrufArt } from '$lib/api/anrufe';
import { anrufAnnehmen, anrufAblehnen, anrufAuflegen, anrufStarten } from '$lib/api/anrufe';
import { sounds } from '$lib/sounds/engine';
import { toast } from 'svelte-sonner';
import { formatiereDauer } from '$lib/attachments/aufnahmeKern';
import { m } from '$lib/paraglide/messages.js';
import { AnrufSystemzeilen, type ZeilenZiel } from './systemzeileKern';
import type { LaufenderAnruf } from './anrufMedien';
import { AnrufMedienZustand, fehlerMelden } from './anrufMedienZustand.svelte';
import { e2eeFaehig } from './anrufSchluesselweg';
import { nativAnbinden, nativAnkommen, nativBeenden } from './anrufHuelle';
import type { AnrufEndgrund } from '$lib/platform/anrufNativ';

const KLINGEL_TIMEOUT_MS = 45_000;

export class AnrufStore extends AnrufMedienZustand {
  /** Overlay-Hinweis während der Angerufene auf den Schlüssel wartet. */
  schluesselWarten = $state(false);

  #klingelWecker: ReturnType<typeof setTimeout> | null = null;
  /** Die Annahme, die DIESES Gerät gerade durchführt — `call_angenommen`
   *  geht an alle Geräte des Kontos, auch an das annehmende selbst; ohne
   *  diesen Merker riss der Zweitgeräte-Abbau dem annehmenden Gerät den
   *  eigenen Anruf weg (Allein-Probe 05.10.). */
  #annahmeLaeuftFuer: string | null = null;
  /** Die Chat-Systemzeile — höchstens eine je Anruf (`systemzeileKern.ts`). */
  #systemzeilen = new AnrufSystemzeilen();

  protected override anrufBeginnt(): void {
    this.#systemzeilen.neuerAnruf();
  }

  /** Vom WS-Bootstrap: dockt die Senke an, die die Systemzeile sendet. */
  zeilenZielSetzen(ziel: ZeilenZiel): void {
    this.#systemzeilen.zielSetzen(ziel);
  }

  async starten(art: AnrufArt, channelId: string, gegenstelle: string): Promise<void> {
    if (this.aktiv) return;
    const schluessel = this.schluessel.neu(art);
    // Sync-Platzhalter schließt das Doppelklick-Fenster vor dem await.
    const platzhalter: LaufenderAnruf = {
      id: '',
      art,
      channel_id: channelId,
      rolle: 'ausgehend',
      gegenstelle,
      zustand: 'klingelt'
    };
    this.aktiv = platzhalter;
    // **Verglichen wird mit dem, was der Zustand ZURÜCKGIBT** — `$state` ist
    // tief und hält einen Proxy, nie `platzhalter` selbst. Mit `platzhalter`
    // verglichen galt jeder Start als „inzwischen aufgelegt" (am
    // kompilierten Modul nachgeprüft, 2026-10-11).
    const eigener = this.aktiv;
    this.anrufBeginnt();
    const medien = this.medienWaehlen();
    try {
      const angabe = await anrufStarten(art, channelId);
      // **Aufgelegt, während der Server die Kennung vergab** (Bughunt T17:
      // bis dahin dauerte das einen APNs-Rundlauf). Bis zum 2026-10-11
      // überschrieb die Antwort den schon geräumten Zustand — die Gegenseite
      // klingelte weiter, hier stand ein Overlay ohne Anruf dahinter.
      if (this.aktiv !== eigener) {
        void anrufAuflegen(angabe.id).catch(() => {});
        return;
      }
      this.aktiv = { ...platzhalter, id: angabe.id };
      void medien.vorbereitenAusgehend(this.aktiv);
      if (schluessel !== null) {
        try {
          await this.schluessel.verteilen(art, channelId, angabe.id, schluessel);
        } catch (e) {
          // Fail-closed: ohne zugestellten Schlüssel keinen Anruf — der WS-
          // Ruf ist durch den POST schon draußen, also den Server-Anruf
          // beenden (sonst klingelt die Gegenseite ins Leere), dann abbrechen.
          fehlerMelden(m.anruf_schluessel_senden_fehlgeschlagen(), e);
          void anrufAuflegen(angabe.id).catch(() => {});
          this.aufräumen('fehler');
          return;
        }
      }
    } catch (e) {
      // Start fehlgeschlagen (Netz, DM weg, Drossel, Sperre) — hier melden,
      // nicht weiterwerfen: die Aufrufer feuern `void`, ein Wurf wäre
      // unbehandelt.
      fehlerMelden(m.anruf_aktion_fehlgeschlagen(), e);
      this.aufräumen('fehler');
    }
    if (this.aktiv) this.#klingelWeckerPlanen();
  }

  /** Eingehender Ruf aus dem WS-Event `call_klingelt` — den Namen der
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
    this.anrufBeginnt();
    this.medienWaehlen();
    sounds.play('notification.dm');
    this.#klingelWeckerPlanen();
    // Sperrbildschirm (Anrufe-Epic E): nativ Full-Screen-Notification zeigen.
    void nativAnkommen(evt.call_id, gegenstelle);
  }

  async annehmen(gegenstelle: string): Promise<void> {
    const anruf = this.aktiv;
    if (!anruf || anruf.rolle !== 'eingehend') return;
    if (this.verbindenLaeuft) return; // Doppel-Tipp auf Annehmen
    this.#annahmeLaeuftFuer = anruf.id;
    // Den Namen der Gegenseite trägt der Aufruf ins Overlay (vom Klienten
    // des Anrufers gesetzt; beim Angerufenen weiss der Store ihn nicht).
    this.aktiv = { ...anruf, gegenstelle };
    this.#klingelWeckerLoeschen();
    const medien = this.medien ?? this.medienWaehlen();
    try {
      await anrufAnnehmen(anruf.id);
      if (medien.nativ) {
        // Nativ trägt CallKit das Gespräch — auch ein hier angenommenes.
        // Die Hülle nimmt dort mit an und übernimmt die Session.
        await medien.vorbereitenAnnahme(this.aktiv ?? anruf);
      } else {
        // **Web-Weg: die Klingel-Anzeige ZUERST weg** (Bughunt E4). Bis zum
        // 2026-10-11 kam das erst nach dem Verbinden — die iOS-Hülle hielt
        // die Session solange für CallKits und übersprang das Aktivieren.
        await nativBeenden('anderswo-angenommen');
      }
      if (e2eeFaehig(anruf.art)) {
        // Fail-closed auf den Schlüssel des Anrufers warten.
        this.schluesselWarten = true;
        const schluessel = await this.schluessel.abwarten(anruf.id);
        this.schluesselWarten = false;
        if (this.aktiv?.id !== anruf.id) return; // inzwischen beendet — Abbau lief
        if (schluessel === null) {
          // Kein Schlüssel, kein Anruf — NICHT unverschlüsselt weitermachen.
          toast.error(m.anruf_schluessel_fehlt());
          void anrufAuflegen(anruf.id).catch(() => {});
          this.aufräumen('fehler');
          return;
        }
      }
      await this.verbinden();
    } catch (e) {
      // Annahme fehlgeschlagen (Anruf inzwischen vorbei?) — sauber abräumen.
      fehlerMelden(m.anruf_aktion_fehlgeschlagen(), e);
      this.aufräumen('fehler');
    }
  }

  /** `grund`: `verpasst`, wenn der Klingel-Wecker ablehnt — CallKit trägt den
   *  Anruf dann als unbeantwortet ein, nicht als abgelehnt. */
  async ablehnen(grund: AnrufEndgrund = 'lokal'): Promise<void> {
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
    this.aufräumen(grund);
  }

  async auflegen(grund: AnrufEndgrund = 'lokal'): Promise<void> {
    const anruf = this.aktiv;
    if (!anruf) return;
    // Klingelt der Anruf noch, stuft der Server das Auflegen als „verpasst“
    // ein (routes/anrufe.py) — dieselbe Einstufung für die eigene Zeile.
    const klingelt = anruf.zustand === 'klingelt';
    this.#systemzeilen.hinterlassen(
      anruf,
      klingelt ? 'verpasst' : 'aufgelegt',
      klingelt ? 0 : this.dauerSekunden
    );
    this.#klingelWeckerLoeschen();
    // Ohne Kennung (der Server vergibt sie noch) gibt es nichts zu beenden —
    // `starten` legt den Anruf auf, sobald sie kommt.
    if (anruf.id !== '') {
      try {
        await anrufAuflegen(anruf.id);
      } catch {
        // Anruf war schon vorbei — der lokale Abbau zählt.
      }
    }
    this.aufräumen(grund);
  }

  /** Vom WS-Handler: Initiator stoppt Klingeln und verbindet. */
  verbindenNachAnnahme(callId: string): void {
    const anruf = this.aktiv;
    if (!anruf || anruf.id !== callId || anruf.rolle !== 'ausgehend') return;
    this.#klingelWeckerLoeschen();
    void this.verbinden();
  }

  /** Vom WS-Handler: `call_angenommen` des EIGENEN Kontos — dieses Gerät
   *  klingelt noch, die Annahme ist an einem anderen Gerät passiert. Hier
   *  abräumen (früher feuerte der 45-s-Wecker ein „ablehnen“, das den
   *  laufenden Anruf auf dem anderen Gerät totlegte, Befund 03.10.). */
  zweitgeraetAngenommen(callId: string): void {
    if (this.#annahmeLaeuftFuer === callId) return; // dieses Gerät selbst nimmt an
    const anruf = this.aktiv;
    if (
      !anruf ||
      anruf.id !== callId ||
      anruf.rolle !== 'eingehend' ||
      anruf.zustand !== 'klingelt'
    ) {
      return;
    }
    toast.info(m.anruf_anderes_geraet_angenommen());
    this.aufräumen('anderswo-angenommen');
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
    this.#systemzeilen.hinterlassen(anruf, grund, dauerSek);
    this.aufräumen(grund === 'verpasst' ? 'verpasst' : 'gegenseite');
    if (anruf.rolle === 'eingehend' && grund === 'verpasst') {
      toast.error(m.anruf_verpasst());
    } else if (grund === 'aufgelegt' && dauerSek > 0) {
      toast.info(m.anruf_beendet_dauer({ dauer: formatiereDauer(dauerSek) }));
    }
  }

  /** Beim Abmelden: das Gespräch beenden. `bearer`: der Zugangstoken, den
   *  `signOut` vor dem Löschen sichert — danach ginge der Ruf ohne durch. */
  abmelden(bearer?: string): void {
    const anruf = this.aktiv;
    if (!anruf) return;
    if (anruf.id !== '') void anrufAuflegen(anruf.id, bearer).catch(() => {});
    this.aufräumen('lokal');
  }

  #klingelWeckerPlanen(): void {
    this.#klingelWeckerLoeschen();
    this.#klingelWecker = setTimeout(() => {
      // Sicherheitskipphebel: ein verspäteter Wecker darf nur noch dann
      // handeln, wenn der Anruf IMMER NOCH klingelt — niemals einen
      // verbundenen Anruf totlegen (Feldbefund 2026-09-08).
      if (this.aktiv?.zustand !== 'klingelt') return;
      if (this.aktiv.rolle === 'ausgehend') void this.auflegen();
      else void this.ablehnen('verpasst');
    }, KLINGEL_TIMEOUT_MS);
  }

  #klingelWeckerLoeschen(): void {
    if (this.#klingelWecker) {
      clearTimeout(this.#klingelWecker);
      this.#klingelWecker = null;
    }
  }

  /** Lokaler Abbau — Raum, Ticker, Zustand. Der Server-POST passiert
   *  getrennt (auflegen/ablehnen), damit Fehler hier nicht hängen bleiben. */
  protected override aufräumen(grund: AnrufEndgrund): void {
    // Klingel-Notification auf dem Sperrbildschirm entfernen — deckt ablehnen,
    // auflegen, call_ende, Klingel-Timeout und Annahme-Fehlschlag ab. Auf iOS
    // schliesst das den CallKit-Anruf und mit ihm den nativen Raum.
    void nativBeenden(grund);
    this.#annahmeLaeuftFuer = null;
    // Auch der Klingel-Wecker gehört zum Aufräumen — sonst feuert der Wecker
    // eines beendeten Anrufs in den NÄCHSTEN hinein und legt ihn still weg.
    this.#klingelWeckerLoeschen();
    this.schluesselWarten = false;
    if (this.aktiv) this.schluessel.vergessen(this.aktiv.id);
    this.medienAbbauen();
  }
}

export const anrufe = new AnrufStore();

// Die native Anzeige (Android: Notification, iOS: CallKit) anbinden — und
// nach einem Reload ein Gespräch übernehmen, das die Hülle noch hält.
nativAnbinden(anrufe);
