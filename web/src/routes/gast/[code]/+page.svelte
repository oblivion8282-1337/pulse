<script lang="ts">
  /**
   * `/gast/<code>` — die ganze Welt eines Gastes.
   *
   * Bewusst AUSSERHALB von `/app`: dort sitzt die Anmelde-Wache, der
   * WebSocket, die Kanalliste und der ganze Konto-Zustand. Ein Gast hat davon
   * nichts, und ein Gast-Zweig quer durch das App-Layout wäre die teuerste
   * Art, dieselbe Seite zu bauen.
   */
  import { onDestroy, onMount } from 'svelte';
  import { page } from '$app/state';
  import { m } from '$lib/paraglide/messages.js';
  import GastVorraum from '$lib/gast/GastVorraum.svelte';
  import GastRaumAnsicht from '$lib/gast/GastRaumAnsicht.svelte';
  import { gastInfo, type GastInfo } from '$lib/gast/api';
  import { gastRaum } from '$lib/gast/gastRaum.svelte';
  import { gastStreams } from '$lib/gast/gastStreams.svelte';

  const code = $derived(page.params.code ?? '');

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

<svelte:head>
  <title>{info ? `${info.channel_name} · ${info.guild_name}` : m.gast_titel_lade()}</title>
  <!-- Ein Besprechungslink gehört nicht in einen Suchindex. -->
  <meta name="robots" content="noindex, nofollow" />
</svelte:head>

{#if gastRaum.phase === 'drin'}
  <GastRaumAnsicht
    titel={gastRaum.beitritt?.channel_name ?? info?.channel_name ?? ''}
    community={gastRaum.beitritt?.guild_name ?? info?.guild_name ?? ''}
  />
{:else if gastRaum.phase === 'weg'}
  <div class="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-3 p-6 text-center">
    <h1 class="text-xl font-semibold">{m.gast_ende_titel()}</h1>
    <p class="text-muted-foreground text-sm">{m.gast_ende_text()}</p>
  </div>
{:else}
  <GastVorraum
    {info}
    {laedt}
    fehler={gastRaum.fehler ?? ladeFehler}
    onBeitreten={beitreten}
  />
{/if}
