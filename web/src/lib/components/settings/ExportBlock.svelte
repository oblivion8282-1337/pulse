<script lang="ts">
  /**
   * Klartext-Export (Etappe E10, Entwurf §6.6) — „deine Daten gehören dir"
   * nachprüfbar statt behauptet: ein Knopf gibt den lokalen Verlauf als
   * lesbares Verzeichnis heraus. Die eigentliche Arbeit steckt in
   * `exportLauf.ts` (Orchestrierung) / `export.ts` (reine Dateiliste) —
   * diese Komponente ist nur Zustand + Anzeige.
   *
   * **Weg-Entscheidung:** File-System-Access-API, dieselbe wie beim
   * Sync-Ordner (`ablage/syncOrdner.ts::wähleOrdner`). Ein einzelner
   * Blob-Download (wie bei `BackupCodesView.svelte`) scheidet aus — das
   * Ergebnis ist ein VERZEICHNIS mit potenziell vielen Dateien
   * (Text je Kanal/Tag, Anhänge einzeln), und ohne neue Abhängigkeit gibt es
   * kein Zip. Firefox/Safari haben den Ordner-Zugriff nicht — dort bleibt
   * nur ein erklärender Hinweis statt eines halben, verwirrenden Exports.
   */
  import { toast } from 'svelte-sonner';
  import DownloadIcon from '@lucide/svelte/icons/download';
  import { Button } from '$lib/components/ui/button/index.js';
  import { syncOrdnerMoeglich, wähleOrdner } from '$lib/ablage/syncOrdner';
  import { fuehreKlartextExportAus, KeinKontoFehler, type ExportFortschritt } from '$lib/ablage/exportLauf';
  import type { ExportVerzeichnis } from '$lib/ablage/exportSchreiber';
  import { m } from '$lib/paraglide/messages.js';

  type Phase = 'ruhig' | 'laeuft' | 'fertig' | 'fehler';
  let phase = $state<Phase>('ruhig');
  let fortschritt = $state<ExportFortschritt>({ fertig: 0, gesamt: 0 });

  const unterstuetzt = syncOrdnerMoeglich();

  async function starteExport(): Promise<void> {
    if (phase === 'laeuft') return;
    const verzeichnis = await wähleOrdner();
    if (!verzeichnis) return; // Nutzer hat abgebrochen — kein Fehler.

    phase = 'laeuft';
    fortschritt = { fertig: 0, gesamt: 0 };
    // `wähleOrdner()` liefert das minimale `AblageVerzeichnis` aus
    // `syncOrdner.ts` (dort bewusst so klein gehalten). Der ECHTE Handle,
    // den `showDirectoryPicker` zurückgibt, ist ein volles
    // `FileSystemDirectoryHandle` und hat `getDirectoryHandle` — nur der
    // TypeScript-Typ kennt es nicht. Der Cast beschreibt also nur, was zur
    // Laufzeit ohnehin da ist, ohne `syncOrdner.ts` (dort arbeitet parallel
    // jemand anders) um Unterordner-Unterstützung zu erweitern.
    const wurzel = verzeichnis as unknown as ExportVerzeichnis;
    try {
      const { fehlstellen } = await fuehreKlartextExportAus(wurzel, (f) => {
        fortschritt = f;
      });
      phase = 'fertig';
      if (fehlstellen > 0) {
        toast.success(m.klartext_export_abgeschlossen_mit_fehlstellen({ anzahl: fehlstellen }));
      } else {
        toast.success(m.klartext_export_abgeschlossen({ ordner: verzeichnis.name }));
      }
    } catch (fehler) {
      phase = 'fehler';
      if (fehler instanceof KeinKontoFehler) {
        toast.error(m.klartext_export_kein_konto());
      } else {
        toast.error(m.klartext_export_fehler());
      }
    }
  }
</script>

<section class="space-y-3" data-testid="export-block">
  <div>
    <h3 class="text-base font-semibold">{m.klartext_export_titel()}</h3>
    <p class="text-sm text-muted-foreground">{m.klartext_export_beschreibung()}</p>
  </div>

  {#if unterstuetzt}
    <Button
      variant="secondary"
      size="sm"
      onclick={starteExport}
      disabled={phase === 'laeuft'}
      data-testid="export-knopf"
    >
      <DownloadIcon class="size-4" />
      {m.klartext_export_knopf()}
    </Button>

    {#if phase === 'laeuft'}
      <p class="text-text-muted text-xs" data-testid="export-fortschritt">
        {m.klartext_export_fortschritt({ fertig: fortschritt.fertig, gesamt: fortschritt.gesamt })}
      </p>
    {/if}
  {:else}
    <p class="text-text-muted text-xs" data-testid="export-nicht-unterstuetzt">
      {m.klartext_export_ordner_nicht_unterstuetzt()}
    </p>
  {/if}
</section>
