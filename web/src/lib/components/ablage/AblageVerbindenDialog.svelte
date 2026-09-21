<script lang="ts">
  /**
   * Ablage-Verbindungs-Assistent — der Dialog zum Verbinden eines
   * Cloud-Laufwerks. Angeschlossen an `SpeicherSektion.svelte`
   * (Einstellungen, Aufgabe 5).
   *
   * Welche Anbieter angeboten werden, entscheidet `lib/ablage/anbieter.ts` —
   * OneDrive und S3 sind nach der Entscheidung des Eigentuemers vom
   * 2026-08-31 nicht im Angebot (Gruende dort im Kopf der Datei).
   *
   * Die Wege je Anbieter:
   *
   * - Dropbox / OneDrive / Google Drive: OAuth mit PKCE (braucht eine
   *   App-Registrierung beim Anbieter, Client-ID in der Konfiguration)
   * - Nextcloud: WebDAV mit App-Passwort
   * - Sync-Ordner: File-System-Access-API, kein Anbieter-Konto nötig
   * - S3: Endpoint + Bucket + Schlüsselpaar
   *
   * Die OAuth-Flows für Dropbox/OneDrive/Google brauchen App-Registrierungen
   * (Client-IDs), die der Instanz-Operator konfiguriert. Ohne die werden die
   * Anbieter ausgegraut.
   */

  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import LockIcon from '@lucide/svelte/icons/lock';
  import { m } from '$lib/paraglide/messages.js';
  import { ablageVerbindungen, type AblageVerbindung } from '$lib/ablage/verbindungen.svelte.ts';
  import { angeboteneAnbieter, type AblageAnbieterArt, type AnbieterEintrag } from '$lib/ablage/anbieter.ts';
  import { ablagePulseApi } from '$lib/api/ablagePulse.ts';
  import { bytesZuBase64 } from '$lib/ablage/syncOrdnerSchluessel.ts';
  import { ANBIETER_IKONE } from './anbieterIkonen.ts';
  import { adapterAusVerzeichnis, wähleOrdner, syncOrdnerMoeglich } from '$lib/ablage/syncOrdner.ts';
  import { legeGriffAb } from '$lib/ablage/ordnerGriff.ts';
  import { probiere } from '$lib/ablage/probe.ts';
  import { SCHRITT_TEXT } from '$lib/ablage/probeSchrittText.ts';
  import { anbieterFuerUmgebung } from '$lib/ablage/anbieterFuerUmgebung.ts';
  import NextcloudVerbinden from './NextcloudVerbinden.svelte';

  let {
    open = false,
    onClose,
    onVerbunden,
    /** Überschreibt die Archiv-Auswahl (`angeboteneAnbieter()`) — das
     *  Community-Laufwerk reicht hier nur das Pulse-Laufwerk durch
     *  (`communityAnbieter()`, Festlegung 2026-09-11). */
    anbieterListe,
    /** Nur für das Pulse-Laufwerk: die Community, die verbunden wird. */
    guildId,
  }: {
    open?: boolean;
    onClose: () => void;
    /** Wird nach erfolgreicher Verbindung gerufen — mit der neuen Verbindung. */
    onVerbunden: (v: AblageVerbindung) => void;
    anbieterListe?: readonly AnbieterEintrag[];
    guildId?: string;
  } = $props();

  /** Kurzbeschreibung je Anbieter — Paraglide je Sprache, deshalb hier und
   *  nicht in `anbieter.ts` (die Liste dort bleibt importfrei/rechnend).
   *  Pulse zeigt in der Liste Name + Beschreibung aus `ablage_pulse_*`;
   *  der Pulse-Eintrag hier bleibt nur als Fallback stehen. */
  const BESCHREIBUNG: Record<AblageAnbieterArt, () => string> = {
    dropbox: m.ablage_verbinden_beschreibung_dropbox,
    onedrive: m.ablage_verbinden_beschreibung_onedrive,
    gdrive: m.ablage_verbinden_beschreibung_gdrive,
    nextcloud: m.ablage_verbinden_beschreibung_nextcloud,
    pulse: m.ablage_verbinden_beschreibung_pulse,
    sync_ordner: m.ablage_verbinden_beschreibung_sync_ordner,
    s3: m.ablage_verbinden_beschreibung_s3,
  };

  // Firefox/Safari koennen keinen Ordner waehlen (kein File-System-Access) —
  // die Ordner-Wahl faellt dort aus der Liste statt erst beim Klick zu
  // scheitern (Plan Aufgabe 4). Cloud-Anbieter bleiben ueberall dabei.
  const anbieter = $derived(
    anbieterFuerUmgebung(anbieterListe ?? angeboteneAnbieter(), syncOrdnerMoeglich())
  );

  let auswahl: AblageAnbieterArt | null = $state(null);
  let verbinde = $state(false);
  let fehler = $state('');

  function schliessen(): void {
    auswahl = null;
    fehler = '';
    onClose();
  }

  function wähle(art: AblageAnbieterArt): void {
    auswahl = art;
    fehler = '';
  }

  async function verbindeSyncOrdner(): Promise<void> {
    verbinde = true;
    fehler = '';
    try {
      const verzeichnis = await wähleOrdner();
      if (!verzeichnis) {
        fehler = m.ablage_verbinden_browser_ohne_ordner();
        return;
      }

      // Erst die Probe, dann verbunden melden (Entwurf §6.3): ein Ordner,
      // der nicht schreiben, lesen oder löschen kann, wird nicht gespeichert
      // — sonst legt jemand einen Kanal auf einem Laufwerk an, das am Ende
      // gar nicht taugt.
      const ergebnis = await probiere(adapterAusVerzeichnis(verzeichnis));
      if (!ergebnis.gut) {
        fehler = m.ablage_verbinden_probe_fehlgeschlagen({
          schritt: SCHRITT_TEXT[ergebnis.schritt],
          grund: ergebnis.grund
        });
        return;
      }

      // Die Kennung ist zugleich die Verbindungs-Id UND der Schlüssel, unter
      // dem `ordnerGriff.ts` das Verzeichnis-Handle in der IndexedDB ablegt
      // — `adapterFür` findet es beim nächsten Start über `konfiguration.griffId`
      // wieder (fällt sonst auf die Verbindungs-Id selbst zurück).
      const griffId = `sync-${Date.now()}`;
      const abgelegt = await legeGriffAb(griffId, verzeichnis);
      if (!abgelegt) {
        fehler = m.ablage_verbinden_griff_nicht_gespeichert();
        return;
      }

      const verbindung: AblageVerbindung = {
        id: griffId,
        anbieter: 'sync_ordner',
        name: verzeichnis.name,
        konfiguration: { griffId },
        hauptschlüsselB64: btoa(String.fromCharCode(...globalThis.crypto.getRandomValues(new Uint8Array(32)))),
        verbundenAm: new Date().toISOString(),
      };
      await ablageVerbindungen.hinzufügen(verbindung);
      onVerbunden(verbindung);
      schliessen();
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) {
        fehler = e instanceof Error ? e.message : String(e);
      }
    } finally {
      verbinde = false;
    }
  }

  async function verbindeFormular(): Promise<void> {
    if (!auswahl) return;
    verbinde = true;
    fehler = '';
    try {
      // Die eigentliche Verbindungslogik (OAuth-Flow, WebDAV-Prüfung,
      // S3-Verbindungsprobe) kommt mit der Krypto-Etappe — hier steht
      // die Struktur dafür.
      fehler = m.ablage_verbinden_noch_nicht_aktiv();
    } finally {
      verbinde = false;
    }
  }
  /**
   * Das Pulse-Laufwerk braucht keinen Anbieter-Konto-Weg — der „Verbinden“-
   * Schritt ist serverseitig nur der Verbunden-Marker, der Schlüssel entsteht
   * hier lokal und verlässt dieses Gerät nie (Konzept §3.1). Nur für
   * Communitys: braucht die Guild-Id, sonst kann der Marker nicht gesetzt
   * werden.
   */
  async function verbindePulse(): Promise<void> {
    if (!guildId) {
      fehler = m.ablage_pulse_fehlt_guild();
      return;
    }
    verbinde = true;
    fehler = '';
    try {
      await ablagePulseApi.verbinden(guildId);
      const verbindung: AblageVerbindung = {
        id: `pulse-${guildId}`,
        anbieter: 'pulse',
        name: m.ablage_pulse_name(),
        konfiguration: {},
        hauptschlüsselB64: bytesZuBase64(
          globalThis.crypto.getRandomValues(new Uint8Array(32))
        ),
        verbundenAm: new Date().toISOString(),
      };
      await ablageVerbindungen.hinzufügen(verbindung);
      await ablageVerbindungen.verknüpfeMitGuild(verbindung.id, guildId);
      onVerbunden(verbindung);
      schliessen();
    } catch (e) {
      fehler = e instanceof Error ? e.message : String(e);
    } finally {
      verbinde = false;
    }
  }
</script>

<Dialog.Root {open} onOpenChange={() => schliessen()}>
  <Dialog.Content class="max-h-[85vh] overflow-y-auto" data-testid="ablage-verbinden-dialog">
    <Dialog.Header>
      <Dialog.Title>{m.ablage_verbinden_titel()}</Dialog.Title>
      <Dialog.Description>
        {m.ablage_verbinden_beschreibung()}
      </Dialog.Description>
    </Dialog.Header>

    {#if !auswahl}
      <div class="space-y-2">
        {#each anbieter as a (a.art)}
          {@const Icon = ANBIETER_IKONE[a.art]}
          <button
            class="flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors hover:border-primary hover:bg-accent"
            onclick={() => wähle(a.art)}
            data-testid="anbieter-{a.art}"
          >
            <Icon class="text-text-muted size-6 shrink-0" />
            <div>
              <div class="font-semibold">
                {a.art === 'pulse' ? m.ablage_pulse_name() : a.name}
              </div>
              <div class="text-xs text-muted-foreground">
                {a.art === 'pulse' ? m.ablage_pulse_beschreibung() : BESCHREIBUNG[a.art]()}
              </div>
            </div>
          </button>
        {/each}
      </div>
    {:else}
      {#if auswahl === 'sync_ordner'}
        <p class="mb-4 text-sm text-muted-foreground">
          {m.ablage_verbinden_sync_hinweis()}
        </p>
        <Button onclick={verbindeSyncOrdner} disabled={verbinde} data-testid="sync-ordner-wählen">
          {m.ablage_verbinden_ordner_waehlen()}
        </Button>
      {:else if auswahl === 'nextcloud'}
        <NextcloudVerbinden
          onVerbunden={(v: AblageVerbindung) => {
            onVerbunden(v);
            schliessen();
          }}
        />
      {:else if auswahl === 'pulse'}
        <p class="mb-4 text-sm text-muted-foreground">
          {m.ablage_pulse_beschreibung()}
        </p>
        <Button onclick={verbindePulse} disabled={verbinde} data-testid="pulse-verbinden">
          {m.ablage_pulse_verbinden()}
        </Button>
      {:else}
        <p class="mb-4 text-sm text-muted-foreground">
          {m.ablage_verbinden_krypto_hinweis({ anbieter: auswahl })}
        </p>
        <Button onclick={() => verbindeFormular()}>{m.ablage_verbinden_knopf()}</Button>
      {/if}
      {#if fehler}
        <p class="mt-2 text-sm text-destructive">{fehler}</p>
      {/if}
    {/if}

    <div class="mt-4 flex items-center gap-2 border-t pt-3 text-xs text-muted-foreground">
      <LockIcon class="size-3.5 shrink-0" />
      {m.ablage_verbinden_schluessel_hinweis()}
    </div>

    <div class="mt-3 text-right">
      <Button variant="ghost" onclick={schliessen}>{m.ablage_verbinden_abbrechen()}</Button>
    </div>
  </Dialog.Content>
</Dialog.Root>
