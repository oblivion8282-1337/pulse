<script lang="ts">
  /**
   * Das Schloss-Kennzeichen im Kopf eines privaten Gespraechs.
   *
   * Zeigt an, ob das Gespraech verschluesselt laufen KANN — also ob die
   * Gegenseite mindestens ein dauerhaftes Geraet hat (Koexistenz-Regel,
   * Spec §3). Die Auskunft kommt aus `krypto/schloss.svelte.ts` und wird je
   * Gegenstelle genau einmal geholt, ueber eine Route, die nichts verbraucht.
   *
   * **Das Schloss garantiert nichts.** Es faerbt ein Symbol nach einer
   * Momentaufnahme vom Betreten des Gespraechs; ob eine einzelne Nachricht
   * verschluesselt geht, entscheidet erst `krypto/senden.ts` beim Absenden mit
   * frisch geholten Buendeln. Meldet die Gegenseite ihr letztes Geraet ab,
   * waehrend das Gespraech offen steht, steht hier weiter ein Schloss und die
   * naechste Nachricht geht trotzdem im Klartext. Deshalb ist der Hover-Text
   * eine Moeglichkeitsaussage („kann") und kein Versprechen.
   *
   * Ohne Auskunft (noch nicht geholt, Abruf fehlgeschlagen, oder
   * `E2E_DMS_ENABLED` aus) wird NICHTS gezeigt — ein kurz aufblitzendes
   * falsches Kennzeichen waere schlimmer als ein spaeter erscheinendes
   * richtiges.
   */
  import LockIcon from '@lucide/svelte/icons/lock';
  import * as Tooltip from '$lib/components/ui/tooltip/index.js';
  import { schloss } from '$lib/krypto/schloss.svelte';
  import { m as pm } from '$lib/paraglide/messages.js';

  let { userId }: { userId: string } = $props();

  // Beim Betreten des Gespraechs einmal fragen. Der Effekt laeuft bei jeder
  // Aenderung von `userId` erneut; die Sperre gegen Mehrfachabrufe sitzt im
  // Speicher (`schlossAbfrage.ts`), nicht hier — sonst haette jede Stelle,
  // die das Kennzeichen einbaut, ihre eigene halbe Sperre.
  $effect(() => {
    schloss.sicherstellen(userId);
  });

  const stand = $derived(schloss.stand(userId));
</script>

{#if stand === true}
  <Tooltip.Provider delayDuration={300}>
    <Tooltip.Root>
      <Tooltip.Trigger>
        {#snippet child({ props })}
          <span
            {...props}
            class="text-text-muted shrink-0"
            data-testid="dm-schloss"
            aria-label={pm.dm_schloss_verschluesselt_label()}
          >
            <LockIcon class="size-4" />
          </span>
        {/snippet}
      </Tooltip.Trigger>
      <Tooltip.Content side="bottom" class="max-w-64 text-left">
        {pm.dm_schloss_verschluesselt_hinweis()}
      </Tooltip.Content>
    </Tooltip.Root>
  </Tooltip.Provider>
{:else if stand === false}
  <!-- Kein Schloss, sondern der Grund: „nicht verschluesselt" allein liesse
       offen, ob es an einem selbst liegt. Es liegt an der Gegenseite, und nur
       sie kann es aendern. -->
  <span class="text-text-muted shrink-0 truncate text-xs" data-testid="dm-kein-schloss">
    {pm.dm_schloss_ohne_app_hinweis()}
  </span>
{/if}
