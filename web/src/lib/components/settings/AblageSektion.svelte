<script lang="ts">
  import { syncOrdnerMoeglich, adapterAusVerzeichnis } from '$lib/ablage/syncOrdner';
  import type { AblageVerzeichnis } from '$lib/ablage/syncOrdner';
  import { ablageVerbindungen } from '$lib/ablage/verbindungen';
  import { DateiSpeicher } from '$lib/ablage/dateispeicher';
  import type { DateiInfo } from '$lib/ablage/dateispeicher';
  import { Button } from '$lib/components/ui/button/index.js';

  let speicher = $state<DateiSpeicher | null>(null);
  let ordnerName = $state('');
  let dateien = $state<DateiInfo[]>([]);
  let laeuft = $state(false);
  let fehler = $state<string | null>(null);

  async function ordnerWählen(): Promise<void> {
    fehler = null;
    try {
      const wahl = (window as unknown as {
        showDirectoryPicker?: (o?: { mode?: string }) => Promise<AblageVerzeichnis>;
      }).showDirectoryPicker;
      if (!wahl) return;
      const verzeichnis = await wahl({ mode: 'readwrite' });
      // Hauptschlüssel liegt gerätelokal in IndexedDB (verbindungen.ts) —
      // nicht mehr in localStorage. Ist IndexedDB nicht erreichbar (z. B.
      // privates Fenster), soll das sichtbar scheitern statt still auf
      // localStorage zurückzufallen — genau der Mischzustand, den der
      // Umzug auflösen sollte.
      const hauptschlüssel = await ablageVerbindungen.hauptschlüsselFürSyncOrdner();
      const adapter = adapterAusVerzeichnis(verzeichnis);
      speicher = new DateiSpeicher(adapter, 'ablage', hauptschlüssel);
      await speicher.laden();
      dateien.length = 0;
      dateien.push(...await speicher.liste());
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
      console.error('Ablage-Ordner:', e);
      fehler = 'Ordner konnte nicht verbunden werden — dieser Browser-Modus unterstützt die Ablage nicht (z. B. privates Fenster).';
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

  {#if fehler}
    <p class="text-sm text-destructive">{fehler}</p>
  {/if}

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
