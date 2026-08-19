<script lang="ts">
  /**
   * Zeigt das Thema eines Kanals als Sprechblase, wenn die Maus auf seinem
   * Eintrag in der Kanalliste steht (2026-08-19).
   *
   * Warum überhaupt: das Thema stand in der Liste nirgends — man sah es erst,
   * nachdem man den Kanal betreten hatte. Und warum als Sprechblase statt als
   * zweiter Zeile unter dem Namen: eine zweite Zeile macht jeden Kanal mit
   * Thema fast doppelt so hoch, und bei vielen Kanälen wird die Liste damit zur
   * Wand. In der Kopfzeile steht das Thema seit heute ohnehin gut lesbar
   * (`ChannelHeading.svelte`); hier geht es nur noch um den Blick hinein, BEVOR
   * man den Kanal betritt.
   *
   * Ohne Thema (und auf Mobil, wo es kein Verweilen gibt) wird der Eintrag
   * unverändert durchgereicht — deshalb die Snippet-Form: der Knopf selbst
   * bleibt in der Liste stehen und wird nicht zweimal aufgeschrieben.
   *
   * Die Verschachtelung Kontextmenü-Trigger → Tooltip-Trigger → Knopf folgt
   * `GuildRail.svelte`; beide Trigger geben Props, die der Knopf nebeneinander
   * aufnimmt. Wer die Reihenfolge dreht, verliert Handler des äusseren.
   */
  import * as Tooltip from '$lib/components/ui/tooltip/index.js';
  import { viewport } from '$lib/stores/viewport.svelte';
  import type { Snippet } from 'svelte';

  let {
    topic,
    children
  }: {
    topic?: string | null;
    /** Der Listeneintrag. Bekommt die Trigger-Props als Argument. */
    children: Snippet<[Record<string, unknown>]>;
  } = $props();
</script>

{#if topic}
  <!-- Länger als im GuildRail (200 ms): über die Kanalliste fährt man ständig
       hinweg, ohne etwas wissen zu wollen — bei 200 ms flackert beim Überfahren
       eine Blase nach der anderen auf. -->
  <Tooltip.Provider delayDuration={450} disabled={viewport.isMobile}>
    <Tooltip.Root>
      <Tooltip.Trigger>
        {#snippet child({ props })}
          {@render children(props)}
        {/snippet}
      </Tooltip.Trigger>
      <Tooltip.Content side="right" class="max-w-64 text-left" data-testid="channel-topic-tooltip">
        {topic}
      </Tooltip.Content>
    </Tooltip.Root>
  </Tooltip.Provider>
{:else}
  {@render children({})}
{/if}
