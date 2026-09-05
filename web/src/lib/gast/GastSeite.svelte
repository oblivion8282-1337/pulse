<script lang="ts">
  /**
   * Die GAST-LOGIK je Code — als KINDKOMPONENTE, nicht in der Route.
   *
   * Grund: SvelteKit recycelt die Seitenkomponente bei einem Parameter-
   * Wechsel (/gast/A → /gast/B) — onMount/onDestroy feuern dann nicht, und
   * der neue Link würde lautos geschluckt, während der Gast weiter in
   * Besprechung A sitzt. Die Route rendert diese Komponente innerhalb von
   * ``{#key code}``: bei Code-Wechsel wird sie vollständig abgebaut und
   * neu gebaut, und JEDE Instanz bekommt ihr eigenes onMount/onDestroy.
   */
  import { onDestroy, onMount } from 'svelte';
  import { m } from '$lib/paraglide/messages.js';
  import GastVorraum from '$lib/gast/GastVorraum.svelte';
  import GastRaumAnsicht from '$lib/gast/GastRaumAnsicht.svelte';
  import { gastInfo, type GastInfo } from '$lib/gast/api';
  import { gastRaum } from '$lib/gast/gastRaum.svelte';
  import { gastStreams } from '$lib/gast/gastStreams.svelte';

  let { code }: { code: string } = $props();

  let info = $state<GastInfo | null>(null);
  let ladeFehler = $state<string | null>(null);
  let laedt = $state(false);

  onMount(async () => {
    // Der Raum ist ein Singleton und überlebt den Seitenwechsel — ein Gast,
    // der verlassen hat und den Link erneut öffnet, sähe sonst weiter die
    // Endseite statt des Vorraums.
    gastRaum.zuruecksetzen();
    gastRaum.beimEnde(() => gastStreams.beenden());
    try {
      info = await gastInfo(code);
    } catch (e) {
      ladeFehler = (e as Error).message || 'fehler';
    }
  });

  async function beitreten(name: string) {
    laedt = true;
    await gastRaum.beitreten(code, name);
    laedt = false;
    const ticket = gastRaum.ticket;
    if (gastRaum.phase === 'drin' && ticket) gastStreams.starten(ticket);
  }

  onDestroy(() => {
    gastRaum.beimEnde(null);
    gastStreams.beenden();
    void gastRaum.verlassen();
  });
</script>

{#if gastRaum.phase === 'drin'}
  <GastRaumAnsicht
    titel={gastRaum.beitritt?.channel_name ?? info?.channel_name ?? ''}
    community={gastRaum.beitritt?.guild_name ?? info?.guild_name ?? ''}
  />
{:else if gastRaum.phase === 'weg'}
  <div class="mx-auto flex min-h-dvh max-w-md flex-col justify-center p-6">
    <div class="bg-card border-border/60 flex flex-col items-center gap-3 rounded-xl border p-8 text-center shadow-2xl">
      <img src="/pulse-mark.svg" alt="Pulse" width="56" height="56" class="size-14" />
      <h1 class="text-xl font-semibold">{m.gast_ende_titel()}</h1>
      <p class="text-muted-foreground text-sm">{m.gast_ende_text()}</p>
    </div>
  </div>
{:else}
  <GastVorraum
    {info}
    {laedt}
    fehler={gastRaum.fehler ?? ladeFehler}
    onBeitreten={beitreten}
  />
{/if}
