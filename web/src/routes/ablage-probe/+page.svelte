<script lang="ts">
  /**
   * Dev-Seite für die verschlüsselte Dateiablage — nur im Dev-Server sichtbar.
   * Ordner wählen (Sync-Ordner) → Dateien hochladen → zurücklesen.
   */
  import { syncOrdnerMoeglich, adapterAusVerzeichnis } from '$lib/ablage/syncOrdner';
  import type { AblageVerzeichnis } from '$lib/ablage/syncOrdner';
  import { DateiSpeicher } from '$lib/ablage/dateispeicher';
  import type { DateiInfo } from '$lib/ablage/dateispeicher';
  import { Button } from '$lib/components/ui/button/index.js';

  const sichtbar = import.meta.env.DEV;

  let speicher = $state<DateiSpeicher | null>(null);
  let ordnerName = $state('');
  const zustand = $state({ dateien: [] as DateiInfo[] });
  let meldungen: string[] = $state([]);
  let laeuft = $state(false);

  function note(zeile: string): void {
    meldungen = [...meldungen.slice(-20), `${new Date().toLocaleTimeString()} — ${zeile}`];
  }

  function holeSchlüssel(): Uint8Array {
    const key = 'pulse-ablage-hauptschluessel';
    let b64 = localStorage.getItem(key);
    if (!b64) {
      const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
      b64 = btoa(String.fromCharCode(...bytes));
      localStorage.setItem(key, b64);
    }
    const bin = atob(b64);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  }

  async function ordnerWählen(): Promise<void> {
    try {
      const wahl = (window as unknown as {
        showDirectoryPicker?: (o?: { mode?: string }) => Promise<AblageVerzeichnis>;
      }).showDirectoryPicker;
      if (!wahl) {
        note('Dieser Browser kann keine Ordner wählen.');
        return;
      }
      const verzeichnis: AblageVerzeichnis = await wahl({ mode: 'readwrite' });
      const adapter = adapterAusVerzeichnis(verzeichnis);
      speicher = new DateiSpeicher(adapter, 'ablage', holeSchlüssel());
      await speicher.laden();
      zustand.dateien.length = 0; zustand.dateien.push(...await speicher.liste());
      note(`Ordner verbunden — ${zustand.dateien.length} Dateien.`);
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) {
        note(`Fehler: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  async function hochladen(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement;
    const dateiListe = input.files;
    if (!dateiListe?.length || !speicher) return;
    laeuft = true;
    try {
      for (const datei of dateiListe) {
        const bytes = new Uint8Array(await datei.arrayBuffer());
        await speicher.hochladen(datei.name, datei.type || 'application/octet-stream', bytes, 'dev');
        note(`✓ ${datei.name} hochgeladen`);
      }
      await speicher.laden();
      zustand.dateien.length = 0; zustand.dateien.push(...await speicher.liste());
    } catch (e) {
      note(`Fehler: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      input.value = '';
      laeuft = false;
    }
  }

  async function herunterladen(name: string): Promise<void> {
    if (!speicher) return;
    try {
      const { inhalt } = await speicher.herunterladen(name);
      const blob = new Blob([inhalt as unknown as BlobPart], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      note(`Fehler: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
</script>

<svelte:head><title>Ablage</title></svelte:head>

{#if sichtbar}
  <div class="mx-auto max-w-2xl space-y-6 p-6">
    <div>
      <h1 class="text-xl font-bold">Verschlüsselte Ablage</h1>
      <p class="text-sm text-muted-foreground">
        Wähle einen Ordner in deinem Sync-Client (OneDrive, Dropbox, Nextcloud …).
        Dateien werden clientseitig verschlüsselt und vom Sync-Client hochgeladen.
      </p>
    </div>

    {#if !speicher}
      <Button onclick={ordnerWählen}>📁 Ordner wählen</Button>
    {:else}
      <div class="rounded-lg border p-4">
        <p class="text-sm font-medium">Ordner: {ordnerName}</p>
        <p class="text-xs text-muted-foreground">{zustand.dateien.length} Dateien · verschlüsselt</p>
      </div>

      <div class="flex gap-2">
        <label>
          <input type="file" multiple class="hidden" onchange={hochladen} disabled={laeuft} />
          <span class="inline-flex cursor-pointer items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground">
            ⬆ Dateien hochladen
          </span>
        </label>
        <Button variant="secondary" size="sm" onclick={() => speicher?.laden()}>
          Neu laden
        </Button>
      </div>

      {#if zustand.dateien.length > 0}
        <div class="rounded-lg border p-4">
          <p class="mb-2 text-sm font-medium">Dateien ({zustand.dateien.length})</p>
          {#each zustand.dateien as datei (datei.id)}
            <div class="flex items-center gap-3 py-1">
              <span>📄</span>
              <span class="text-sm">{datei.name}</span>
              <span class="text-xs text-muted-foreground">{datei.groesse} B</span>
              <button
                class="ml-auto text-xs text-primary hover:underline"
                onclick={() => herunterladen(datei.name)}
              >⬇</button>
            </div>
          {/each}
        </div>
      {/if}
    {/if}

    {#each meldungen as zeile (zeile)}
      <p class="text-xs text-muted-foreground">{zeile}</p>
    {/each}
  </div>
{:else}
  <div class="p-8 text-center text-muted-foreground">
    <p>Diese Seite ist nur im Dev-Server verfügbar.</p>
  </div>
{/if}
