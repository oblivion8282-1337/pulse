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
  import { ablageVerbindungen, type AblageVerbindung } from '$lib/ablage/verbindungen.svelte.ts';
  import { angeboteneAnbieter, type AblageAnbieterArt } from '$lib/ablage/anbieter.ts';
  import { ANBIETER_IKONE } from './anbieterIkonen.ts';
  import { adapterAusVerzeichnis, wähleOrdner, syncOrdnerMoeglich } from '$lib/ablage/syncOrdner.ts';
  import { legeGriffAb } from '$lib/ablage/ordnerGriff.ts';
  import { probiere, type ProbeSchritt } from '$lib/ablage/probe.ts';
  import { anbieterFuerUmgebung } from '$lib/ablage/anbieterFuerUmgebung.ts';
  import NextcloudVerbinden from './NextcloudVerbinden.svelte';

  let {
    open = false,
    onClose,
    onVerbunden,
  }: {
    open?: boolean;
    onClose: () => void;
    /** Wird nach erfolgreicher Verbindung gerufen — mit der neuen Verbindung. */
    onVerbunden: (v: AblageVerbindung) => void;
  } = $props();

  /** Kurzbeschreibung je Anbieter — reiner Anzeigetext, deshalb hier und
   *  nicht in `anbieter.ts` (die Liste dort bleibt importfrei/rechnend). */
  const BESCHREIBUNG: Record<AblageAnbieterArt, string> = {
    dropbox: 'Mit deinem Dropbox-Konto verbinden — App-Ordner, nur Pulse sieht ihn',
    onedrive: 'Mit deinem Microsoft-Konto verbinden — versteckter App-Ordner',
    gdrive: 'Nur app-erzeugte Dateien sichtbar — dein restliches Drive bleibt privat',
    nextcloud: 'Freigabe-Link aus deiner Nextcloud einfügen — mehr braucht es nicht',
    sync_ordner: 'Ein lokaler Ordner — dein Dropbox-/Drive-/Nextcloud-Client trägt die Dateien hoch',
    s3: 'Hetzner, Wasabi, MinIO — Endpoint, Bucket und Schlüssel angeben',
  };

  const SCHRITT_TEXT: Record<ProbeSchritt, string> = {
    schreiben: 'Schreiben',
    lesen: 'Lesen',
    vergleichen: 'Vergleichen',
    loeschen: 'Löschen',
  };

  // Firefox/Safari koennen keinen Ordner waehlen (kein File-System-Access) —
  // die Ordner-Wahl faellt dort aus der Liste statt erst beim Klick zu
  // scheitern (Plan Aufgabe 4). Cloud-Anbieter bleiben ueberall dabei.
  const anbieter = anbieterFuerUmgebung(angeboteneAnbieter(), syncOrdnerMoeglich());

  let auswahl: AblageAnbieterArt | null = $state(null);
  let verbinde = $state(false);
  let fehler = $state('');
  let webdavUrl = $state('');
  let webdavBenutzer = $state('');
  let webdavPasswort = $state('');
  let s3Wirt = $state('');
  let s3Region = $state('');
  let s3Eimer = $state('');
  let s3Schluessel = $state('');
  let s3Geheimnis = $state('');
  let s3Praefix = $state('');

  const brauchtFormular = $derived(auswahl === 's3');

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
        fehler = 'Dieser Browser kann keine Ordner wählen — Chrome, Edge oder die Desktop-App nehmen.';
        return;
      }

      // Erst die Probe, dann verbunden melden (Entwurf §6.3): ein Ordner,
      // der nicht schreiben, lesen oder löschen kann, wird nicht gespeichert
      // — sonst legt jemand einen Kanal auf einem Laufwerk an, das am Ende
      // gar nicht taugt.
      const ergebnis = await probiere(adapterAusVerzeichnis(verzeichnis));
      if (!ergebnis.gut) {
        fehler = `Verbindung fehlgeschlagen beim Schritt „${SCHRITT_TEXT[ergebnis.schritt]}": ${ergebnis.grund}`;
        return;
      }

      // Die Kennung ist zugleich die Verbindungs-Id UND der Schlüssel, unter
      // dem `ordnerGriff.ts` das Verzeichnis-Handle in der IndexedDB ablegt
      // — `adapterFür` findet es beim nächsten Start über `konfiguration.griffId`
      // wieder (fällt sonst auf die Verbindungs-Id selbst zurück).
      const griffId = `sync-${Date.now()}`;
      const abgelegt = await legeGriffAb(griffId, verzeichnis);
      if (!abgelegt) {
        fehler = 'Der Ordner-Zugriff konnte nicht gespeichert werden — nach einem Neuladen müsste er neu gewählt werden.';
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
      fehler = 'Die Verbindung für diesen Anbieter ist noch nicht aktiv — braucht die Krypto-Etappe.';
    } finally {
      verbinde = false;
    }
  }
</script>

<Dialog.Root {open} onOpenChange={() => schliessen()}>
  <Dialog.Content class="max-h-[85vh] overflow-y-auto" data-testid="ablage-verbinden-dialog">
    <Dialog.Header>
      <Dialog.Title>Ablage verbinden</Dialog.Title>
      <Dialog.Description>
        Wähle, wo deine verschlüsselten Kanäle und Dateien liegen sollen.
        Der Pulse-Server sieht den Inhalt nie.
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
              <div class="font-semibold">{a.name}</div>
              <div class="text-xs text-muted-foreground">{BESCHREIBUNG[a.art]}</div>
            </div>
          </button>
        {/each}
      </div>
    {:else}
      {#if auswahl === 'sync_ordner'}
        <p class="mb-4 text-sm text-muted-foreground">
          Wähle einen lokalen Ordner. Dein Dropbox-, Drive- oder Nextcloud-Client
          synchronisiert ihn in deine Cloud — Pulse schreibt nur dort hinein.
        </p>
        <Button onclick={verbindeSyncOrdner} disabled={verbinde} data-testid="sync-ordner-wählen">
          Ordner wählen
        </Button>
      {:else if auswahl === 'nextcloud'}
        <NextcloudVerbinden
          onVerbunden={(v: AblageVerbindung) => {
            onVerbunden(v);
            schliessen();
          }}
        />
      {:else}
        <p class="mb-4 text-sm text-muted-foreground">
          Die Verbindung für <strong>{auswahl}</strong> braucht die Krypto-Etappe —
          die Anbindungslogik ist gebaut und getestet, aber noch nicht mit echten
          OAuth-Client-IDs verknüpft.
        </p>
        <Button onclick={() => verbindeFormular()}>Verbinden</Button>
      {/if}
      {#if fehler}
        <p class="mt-2 text-sm text-destructive">{fehler}</p>
      {/if}
    {/if}

    <div class="mt-4 flex items-center gap-2 border-t pt-3 text-xs text-muted-foreground">
      <LockIcon class="size-3.5 shrink-0" />
      Deine Schlüssel verlassen dieses Gerät nie. Der Pulse-Server sieht
      weder deine Dateien noch deine Zugangsdaten.
    </div>

    <div class="mt-3 text-right">
      <Button variant="ghost" onclick={schliessen}>Abbrechen</Button>
    </div>
  </Dialog.Content>
</Dialog.Root>
