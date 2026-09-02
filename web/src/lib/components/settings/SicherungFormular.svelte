<script lang="ts">
  /** Das Passwort-Formular der Sicherung — festlegen (neues Archiv) oder
   *  eingeben (vorhandenes Archiv eines anderen Geräts). Rein präsentativ;
   *  das Öffnen tut die Sektion. */
  import { Button } from '$lib/components/ui/button/index.js';
  import { m } from '$lib/paraglide/messages.js';
  import CheckIcon from '@lucide/svelte/icons/check';
  import XIcon from '@lucide/svelte/icons/x';

  const { neu, laeuft, aufOeffnen, aufAbbrechen, ordnerModus, aufZugriff } = $props<{
    neu: boolean;
    laeuft: boolean;
    aufOeffnen: (passwort: string, passwort2: string) => void;
    /** Nur im Festlegen-Schritt: Verbindung wieder trennen (Befund 2026-09-02). */
    aufAbbrechen?: () => void;
    /** Nur beim Ordner-Ziel: Zugriff mit Geste erneuern. */
    ordnerModus: boolean;
    aufZugriff: () => void;
  }>();

  let passwort = $state('');
  let passwort2 = $state('');

  // Live-Voraussetzungen statt nur einer Fehlermeldung hinterher: der Nutzer
  // sieht JEDE Regel und woran es noch hängt, bevor er den Knopf drückt.
  const reichlich = $derived(passwort.length >= 8);
  const gleich = $derived(neu && passwort2.length > 0 && passwort === passwort2);
  const gueltig = $derived(reichlich && (!neu || gleich));
</script>

<div class="space-y-2">
  <p class="text-sm text-muted-foreground">
    {neu ? m.sicherung_passwort_neu() : m.sicherung_passwort_eingeben()}
  </p>
  <input class="w-full rounded-md border bg-transparent px-3 py-1.5 text-sm" type="password" bind:value={passwort} />
  {#if neu}
    <input class="w-full rounded-md border bg-transparent px-3 py-1.5 text-sm" type="password" placeholder={m.sicherung_passwort_wiederholen()} bind:value={passwort2} />
  {/if}
  {#if neu}
    <ul class="space-y-1 text-xs" data-testid="sicherung-passwort-checkliste">
      <li class="flex items-center gap-1.5 {reichlich ? 'text-success' : 'text-muted-foreground'}">
        {#if reichlich}<CheckIcon class="size-3.5" />{:else}<XIcon class="size-3.5" />{/if}
        {m.sicherung_passwort_zeichen({ n: passwort.length })}
      </li>
      {#if passwort2.length > 0}
        <li class="flex items-center gap-1.5 {gleich ? 'text-success' : 'text-muted-foreground'}">
          {#if gleich}<CheckIcon class="size-3.5" />{:else}<XIcon class="size-3.5" />{/if}
          {m.sicherung_passwort_gleich()}
        </li>
      {/if}
    </ul>
  {/if}
  <div class="flex items-center gap-2">
    <Button onclick={() => aufOeffnen(passwort, passwort2)} size="sm" disabled={laeuft || (neu && !gueltig)}>
      {laeuft ? m.sicherung_laebt() : neu ? m.sicherung_aktivieren() : m.sicherung_oeffnen()}
    </Button>
    {#if neu && aufAbbrechen}
      <Button
        variant="outline"
        size="sm"
        class="border-neutral-600 hover:bg-neutral-700"
        onclick={aufAbbrechen}
        disabled={laeuft}
        data-testid="sicherung-abbrechen"
      >
        {m.sicherung_abbrechen()}
      </Button>
    {/if}
  </div>
  {#if ordnerModus}
    <button class="block text-xs text-muted-foreground hover:underline" onclick={aufZugriff}>
      Ordner-Zugriff erneut erlauben
    </button>
  {/if}
</div>
