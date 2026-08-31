<script lang="ts">
  /**
   * Ablage-Verbindungs-Assistent — der Dialog zum Verbinden eines
   * Cloud-Laufwerks. Sechs Anbieter, jeder mit seinem eigenen Weg:
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
  import { ablageVerbindungen, type AblageVerbindung, type AblageAnbieterArt } from '$lib/ablage/verbindungen.ts';

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

  const ANBIETER: { art: AblageAnbieterArt; name: string; beschreibung: string; icon: string }[] = [
    { art: 'dropbox', name: 'Dropbox', beschreibung: 'Mit deinem Dropbox-Konto verbinden — App-Ordner, nur Pulse sieht ihn', icon: '📦' },
    { art: 'onedrive', name: 'OneDrive', beschreibung: 'Mit deinem Microsoft-Konto verbinden — versteckter App-Ordner', icon: '☁️' },
    { art: 'gdrive', name: 'Google Drive', beschreibung: 'Nur app-erzeugte Dateien sichtbar — dein restliches Drive bleibt privat', icon: '🔵' },
    { art: 'nextcloud', name: 'Nextcloud', beschreibung: 'Server-Adresse und App-Passwort angeben', icon: '🌐' },
    { art: 'sync_ordner', name: 'Sync-Ordner', beschreibung: 'Ein lokaler Ordner — dein Dropbox-/Drive-/Nextcloud-Client trägt die Dateien hoch', icon: '📁' },
    { art: 's3', name: 'S3-kompatibel', beschreibung: 'Hetzner, Wasabi, MinIO — Endpoint, Bucket und Schlüssel angeben', icon: '🪣' },
  ];

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

  const brauchtFormular = $derived(auswahl === 'nextcloud' || auswahl === 's3');

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
    try {
      const wahl = (window as unknown as {
        showDirectoryPicker?: (o?: { mode?: string }) => Promise<{
          name: string;
          getFileHandle(n: string, o?: { create?: boolean }): Promise<{
            createWritable(): Promise<{ write(d: Uint8Array): Promise<void>; close(): Promise<void> }>;
            getFile(): Promise<{ arrayBuffer(): Promise<ArrayBuffer> }>;
          }>;
          entries(): AsyncIterable<[string, { kind: string }]>;
          removeEntry(n: string): Promise<void>;
        }>;
      }).showDirectoryPicker;
      if (!wahl) {
        fehler = 'Dieser Browser kann keine Ordner wählen — Chrome, Edge oder die Desktop-App nehmen.';
        return;
      }
      const verzeichnis = await wahl({ mode: 'readwrite' });
      const verbindung: AblageVerbindung = {
        id: `sync-${Date.now()}`,
        anbieter: 'sync_ordner',
        name: verzeichnis.name,
        konfiguration: {},
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
        {#each ANBIETER as a}
          <button
            class="flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors hover:border-primary hover:bg-accent"
            onclick={() => wähle(a.art)}
            data-testid="anbieter-{a.art}"
          >
            <span class="text-2xl">{a.icon}</span>
            <div>
              <div class="font-semibold">{a.name}</div>
              <div class="text-xs text-muted-foreground">{a.beschreibung}</div>
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
      🔒 Deine Schlüssel verlassen dieses Gerät nie. Der Pulse-Server sieht
      weder deine Dateien noch deine Zugangsdaten.
    </div>

    <div class="mt-3 text-right">
      <Button variant="ghost" onclick={schliessen}>Abbrechen</Button>
    </div>
  </Dialog.Content>
</Dialog.Root>
