<script lang="ts">
  import { syncOrdnerMoeglich, adapterAusVerzeichnis } from '$lib/ablage/syncOrdner';
  import type { AblageVerzeichnis } from '$lib/ablage/syncOrdner';
  import { DateiSpeicher } from '$lib/ablage/dateispeicher';
  import type { DateiInfo } from '$lib/ablage/dateispeicher';
  import { Button } from '$lib/components/ui/button/index.js';

  let speicher = $state<DateiSpeicher | null>(null);

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
  let ordnerName = $state('');
  let dateien = $state<DateiInfo[]>([]);
  let laeuft = $state(false);

  function baueAdapter(verzeichnis: AblageVerzeichnis) {
    return {
      async schreibe(datei: string, inhalt: Uint8Array) {
        const h = await verzeichnis.getFileHandle(datei, { create: true });
        const w = await h.createWritable();
        await w.write(inhalt);
        await w.close();
      },
      async lese(datei: string): Promise<Uint8Array | null> {
        try {
          const h = await verzeichnis.getFileHandle(datei);
          const f = await h.getFile();
          return new Uint8Array(await f.arrayBuffer());
        } catch { return null; }
      },
      async liste() {
        const namen: string[] = [];
        for await (const [name, eintrag] of verzeichnis.entries()) {
          if (eintrag.kind === 'file') namen.push(name);
        }
        return namen;
      },
      async lösche(datei: string) {
        try { await verzeichnis.removeEntry(datei); } catch { /* egal */ }
      },
    };
  }

  async function ordnerWählen(): Promise<void> {
    try {
      const wahl = (window as unknown as {
        showDirectoryPicker?: (o?: { mode?: string }) => Promise<AblageVerzeichnis>;
      }).showDirectoryPicker;
      if (!wahl) return;
      const verzeichnis = await wahl({ mode: 'readwrite' });
      const adapter = baueAdapter(verzeichnis);
      speicher = new DateiSpeicher(adapter, 'ablage', holeSchlüssel());
      await speicher.laden();
      dateien.length = 0;
      dateien.push(...await speicher.liste());
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) {
        console.error('Ablage-Ordner:', e);
      }
    }
  }

  async function hochladen(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement;
    const hochgeladene = input.files;
    if (!hochgeladene?.length || !speicher) return;
    laeuft = true;
    try {
      for (const datei of hochgeladene) {
        const bytes = new Uint8Array(await datei.arrayBuffer());
        await speicher.hochladen(datei.name, datei.type || 'application/octet-stream', bytes, 'dev');
      }
      await speicher.laden();
      dateien.length = 0;
      dateien.push(...await speicher.liste());
    } finally {
      input.value = '';
      laeuft = false;
    }
  }

  async function löschen(datei: DateiInfo): Promise<void> {
    if (!speicher) return;
    await speicher.löschen(datei.id);
    await speicher.laden();
    dateien = await speicher.liste();
  }
</script>

<div class="space-y-4">
  <h3 class="text-sm font-semibold">Ablage</h3>
  <p class="text-sm text-muted-foreground">
    Verbinde einen Ordner aus deinem Cloud-Sync (OneDrive, Dropbox, Nextcloud …).
    Dateien werden verschlüsselt und dein Sync-Client trägt sie in deine Cloud.
  </p>

  {#if !syncOrdnerMoeglich()}
    <p class="text-sm text-muted-foreground">Dieser Browser unterstützt keine Ordner-Wahl.</p>
  {:else if !speicher}
    <Button onclick={ordnerWählen} variant="secondary" size="sm">Ordner verbinden</Button>
  {:else}
    <div class="flex items-center justify-between">
      <span class="text-sm font-medium">Ordner: {ordnerName}</span>
      <Button variant="secondary" size="sm" onclick={() => speicher?.laden()}>Neu laden</Button>
    </div>

    <div class="space-y-1">
      {#each dateien as datei (datei.id)}
        <div class="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-muted">
          <span>📄</span>
          <span class="text-sm flex-1">{datei.name}</span>
          <span class="text-xs text-muted-foreground">{datei.groesse} B</span>
          <button class="text-xs text-destructive hover:underline" onclick={() => löschen(datei)}>Löschen</button>
        </div>
      {/each}
      {#if dateien.length === 0}
        <p class="text-sm text-muted-foreground">Noch keine Dateien.</p>
      {/if}
    </div>
  {/if}

  <label>
    <input type="file" multiple class="hidden" onchange={hochladen} disabled={laeuft} />
    <span class="inline-flex cursor-pointer items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground">
      Dateien hochladen
    </span>
  </label>
</div>
