<!--
  Watch-Popup-Layout — entkoppelte Watch-Partys. Die Shell (Auth + Gateway +
  schwarzem Vollbild-Hintergrund) lebt in `PopupShell.svelte`.
  Multi-Tab/Multi-Window ist seitens des Backends unkritisch (jede Gateway-
  Connection = eigene Session am chat-gateway).
-->
<script lang="ts">
  import PopupShell from '$lib/components/PopupShell.svelte';
  import { m } from '$lib/paraglide/messages.js';
  import { watchFehlerWacht } from '$lib/watch/fehlerwacht.svelte';

  let { children } = $props();

  // Ablehnungen des Servers zur Watch-Party sichtbar machen. Einmal je
  // Fenster — Begruendung in `watch/fehlerwacht.svelte.ts`.
  watchFehlerWacht();
</script>

<PopupShell
  title={m.watch_popup_page_title()}
  loadingLabel={m.watch_popup_loading()}
  logLabel="watch-popup gateway connect"
>
  {@render children()}
</PopupShell>
