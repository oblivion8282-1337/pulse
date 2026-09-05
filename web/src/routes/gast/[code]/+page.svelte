<script lang="ts">
  /**
   * `/gast/<code>` — die ganze Welt eines Gastes.
   *
   * Bewusst AUSSERHALB von `/app`: dort sitzt die Anmelde-Wache, der
   * WebSocket, die Kanalliste und der ganze Konto-Zustand. Ein Gast hat davon
   * nichts, und ein Gast-Zweig quer durch das App-Layout wäre die teuerste
   * Art, dieselbe Seite zu bauen.
   *
   * Die LOGIK (Beitritt, Räumung, Abfragen) lebt in ``GastSeite`` und wird
   * über ``{#key code}`` gemountet: SvelteKit recycelt die Seitenkomponente
   * bei einem Parameter-Wechsel (/gast/A → /gast/B), und onMount/onDestroy
   * würden NICHT feuern — der neue Link würde lautos geschluckt. Der Key
   * erzwingt den vollen Auf-/Abbau je Code, weil ``GastSeite`` eine
   * Kindkomponente ist.
   */
  import { page } from '$app/state';
  import { m } from '$lib/paraglide/messages.js';
  import GastSeite from '$lib/gast/GastSeite.svelte';

  const code = $derived(page.params.code ?? '');
</script>

<svelte:head>
  <title>{m.gast_titel_lade()}</title>
  <!-- Ein Besprechungslink gehört nicht in einen Suchindex. -->
  <meta name="robots" content="noindex, nofollow" />
</svelte:head>

{#key code}
  <GastSeite {code} />
{/key}
