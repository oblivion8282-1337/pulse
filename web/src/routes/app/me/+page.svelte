<script lang="ts">
  /**
   * Der Du-Bereich.
   *
   * Auf dem Handy die Liste allein — ein Eintrag schiebt seinen Bildschirm
   * auf. Ab `md` steht rechts daneben Platz, den die Liste nicht fuellen
   * soll; dort erklaert ein Platzhalter, was zu tun ist. Die Liste selbst
   * lebt in `MeSectionList`, weil die Detail-Route sie auf dem Tablet
   * daneben zeigt.
   */
  import MeSectionList from '$lib/components/mobile/MeSectionList.svelte';
  import TabletPlaceholder from '$lib/components/mobile/TabletPlaceholder.svelte';
  import { viewport } from '$lib/stores/viewport.svelte';
  import { m } from '$lib/paraglide/messages.js';
</script>

<MeSectionList />

{#if !viewport.isMobile}
  <TabletPlaceholder text={m.me_pick_section()} />
{/if}
