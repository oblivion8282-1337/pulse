<script lang="ts">
  /** Das Passwort-Formular der Sicherung — festlegen (neues Archiv) oder
   *  eingeben (vorhandenes Archiv eines anderen Geräts). Rein präsentativ;
   *  das Öffnen tut die Sektion. */
  import { Button } from '$lib/components/ui/button/index.js';

  const { neu, laeuft, aufOeffnen, ordnerModus, aufZugriff } = $props<{
    neu: boolean;
    laeuft: boolean;
    aufOeffnen: (passwort: string, passwort2: string) => void;
    /** Nur beim Ordner-Ziel: Zugriff mit Geste erneuern. */
    ordnerModus: boolean;
    aufZugriff: () => void;
  }>();

  let passwort = $state('');
  let passwort2 = $state('');
</script>

<div class="space-y-2">
  <p class="text-sm text-muted-foreground">
    {neu ? 'Lege dein Sicherungs-Passwort fest (mindestens 8 Zeichen — gut merken, es gibt keine Wiederherstellung):' : 'Gib dein Sicherungs-Passwort ein:'}
  </p>
  <input class="w-full rounded-md border bg-transparent px-3 py-1.5 text-sm" type="password" bind:value={passwort} />
  {#if neu}
    <input class="w-full rounded-md border bg-transparent px-3 py-1.5 text-sm" type="password" placeholder="Wiederholen" bind:value={passwort2} />
  {/if}
  <Button onclick={() => aufOeffnen(passwort, passwort2)} size="sm" disabled={laeuft || passwort.length === 0}>
    {laeuft ? 'Lädt …' : neu ? 'Sicherung aktivieren' : 'Öffnen'}
  </Button>
  {#if ordnerModus}
    <button class="block text-xs text-muted-foreground hover:underline" onclick={aufZugriff}>
      Ordner-Zugriff erneut erlauben
    </button>
  {/if}
</div>
