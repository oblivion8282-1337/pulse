<script lang="ts">
  /** Die Ziel-Wahl der Sicherung als Anbieter-Liste: je Ziel eine Zeile
   *  (Icon, Name, Beschreibung, Verbinden-Knopf bzw. ✓) — das Muster der
   *  Einladungs-Karten. Neue Anbieter (Nextcloud, Dropbox, …) sind nur
   *  weitere Zeilen, kein Umbau. Rein präsentativ; die Logik liegt in der
   *  Sektion. */
  import { Button } from '$lib/components/ui/button/index.js';
  import { syncOrdnerMoeglich } from '$lib/ablage/syncOrdner';
  import { isElectron } from '$lib/platform/runtime';
  import CheckIcon from '@lucide/svelte/icons/check';
  import { m } from '$lib/paraglide/messages.js';

  const { laeuft, gdriveAktiv, ordnerAktiv, aufGoogle, aufOrdner, aufVerwalten } = $props<{
    laeuft: boolean;
    gdriveAktiv: boolean;
    ordnerAktiv: boolean;
    aufGoogle: () => void;
    aufOrdner: () => void;
    /** In der Übersicht: verbundene Ziele springen in die Verwaltung. */
    aufVerwalten?: (ziel: 'gdrive' | 'ordner') => void;
  }>();

  /** Der Anbieter-Katalog — ein Eintrag je Zeile, weitere später ergänzen. */
  const anbieter: {
    kennung: 'gdrive' | 'ordner';
    kuerzel: string;
    name: string;
    aktiv: boolean;
    aufVerbinden: () => void;
  }[] = $derived([
    {
      kennung: 'gdrive',
      kuerzel: 'G',
      name: m.sicherung_ziel_gdrive(),
      aktiv: gdriveAktiv,
      aufVerbinden: aufGoogle
    },
    ...(isElectron() && syncOrdnerMoeglich()
      ? [
          {
            kennung: 'ordner' as const,
            kuerzel: 'O',
            name: m.sicherung_ziel_ordner(),
            aktiv: ordnerAktiv,
            aufVerbinden: aufOrdner
          }
        ]
      : [])
  ]);
</script>

<div class="space-y-2">
  <p class="text-text-muted px-1 text-xs font-semibold uppercase tracking-wide">{m.sicherung_ziel_heading()}</p>
  <div class="flex flex-col gap-2">
    {#each anbieter as a (a.kennung)}
      <div
        class="border-border bg-bg-input flex items-center gap-3 rounded-[14px] border px-3 py-2.5"
        data-testid="sicherung-ziel-{a.kennung}"
      >
        <span
          class="accent-gradient text-primary-foreground flex size-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold"
        >
          {a.kuerzel}
        </span>
        <div class="min-w-0 flex-1">
          <p class="text-text-bright truncate text-sm font-semibold">{a.name}</p>
        </div>
        {#if a.aktiv}
          <span class="text-success flex shrink-0 items-center gap-1 text-sm" data-testid="sicherung-ziel-verbunden">
            <CheckIcon class="size-4" />
            {m.sicherung_ziel_verbunden()}
          </span>
          {#if aufVerwalten}
            <Button
              variant="outline"
              size="sm"
              onclick={() => aufVerwalten(a.kennung)}
              data-testid="sicherung-verwalten-{a.kennung}"
            >
              {m.sicherung_ziel_verwalten()}
            </Button>
          {/if}
        {:else}
          <Button
            size="sm"
            onclick={a.aufVerbinden}
            disabled={laeuft}
            data-testid="sicherung-ziel-verbinden-{a.kennung}"
          >
            {laeuft && a.kennung === 'gdrive' ? m.sicherung_ziel_wartet() : m.sicherung_ziel_verbinden()}
          </Button>
        {/if}
      </div>
    {/each}
  </div>
  {#if !isElectron()}
    <p class="text-xs text-muted-foreground">
      {m.sicherung_ziel_browser_hinweis()}
    </p>
  {/if}
</div>
