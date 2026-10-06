<script lang="ts">
  /**
   * Eine Einstellungs-Seite als aufgeschobener Bildschirm — die zweite Ebene
   * des Du-Bereichs.
   *
   * Zeigt **dieselbe** Komponente wie der Reiter im Einstellungsdialog
   * (`SettingsPanel`); nur der Rahmen ist ein anderer. Ein zweiter Satz
   * mobiler Einstellungs-Bildschirme wäre die sicherste Art gewesen, dass
   * eine Einstellung irgendwann nur noch an einem der beiden Orte existiert.
   *
   * Eine unbekannte oder hier nicht sichtbare Kennung führt zurück zur
   * Übersicht statt still etwas Falsches zu zeigen — der Fallback in
   * `SettingsPanel` zeigt sonst die Sicherheits-Seite, was aus einem Tippfehler
   * in der Adresse einen verwirrenden Bildschirm machte.
   */
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
  import { viewport } from '$lib/stores/viewport.svelte';
  import { getSettingsTabs } from '$lib/components/settingsTabs';
  import { sichtbareReiterJetzt } from '$lib/components/settings/reiterAuswahl.svelte';
  import SettingsPanel from '$lib/components/settings/SettingsPanel.svelte';
  import MeSectionList from '$lib/components/mobile/MeSectionList.svelte';
  import type { SettingsTab } from '$lib/components/SettingsDialog.svelte';
  import { m } from '$lib/paraglide/messages.js';

  const tabs = getSettingsTabs();

  let sichtbar = $derived(sichtbareReiterJetzt(tabs));

  let kennung = $derived(page.params.section ?? '');
  let eintrag = $derived(sichtbar.find((t) => t.id === kennung) ?? null);

  $effect(() => {
    if (!eintrag) void goto('/app/me', { replaceState: true });
  });
</script>

<!-- Ab `md` steht die Liste daneben (Master-Detail): auf einem Tablet ist der
     Platz da, und ein aufgeschobener Vollbild-Screen verschenkte ihn. -->
{#if !viewport.isMobile}
  <MeSectionList aktiv={kennung} />
{/if}

<div
  class="glass-panel flex h-full min-w-0 flex-1 flex-col overflow-hidden rounded-none md:rounded-2xl"
  data-testid="me-section-page"
>
  <header class="border-border text-text-bright flex h-14 shrink-0 items-center gap-1 border-b px-2">
    {#if viewport.isMobile}
      <button
        class="text-text-muted hover:text-primary flex min-h-12 min-w-12 items-center justify-center"
        onclick={() => goto('/app/me')}
        data-testid="me-section-back"
        aria-label={m.settings_dialog_back()}
      >
        <ChevronLeftIcon class="size-6" />
      </button>
    {/if}
    <span class="truncate text-base font-bold tracking-tight">{eintrag?.label ?? ''}</span>
  </header>

  <div class="flex-1 overflow-y-auto px-4 pb-6 pt-4">
    {#if eintrag}
      <SettingsPanel tab={eintrag.id as SettingsTab} />
    {/if}
  </div>
</div>
