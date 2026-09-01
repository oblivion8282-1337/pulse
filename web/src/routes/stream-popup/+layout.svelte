<!--
  Stream-Popup-Layout — entkoppelte HQ-Streams. Die Shell (Auth + Gateway +
  schwarzem Vollbild-Hintergrund) lebt in `PopupShell.svelte`.
-->
<script lang="ts">
  import PopupShell from '$lib/components/PopupShell.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let { children } = $props();
</script>

<PopupShell
  title={m.stream_popup_page_title()}
  loadingLabel={m.stream_popup_loading()}
  logLabel="popup gateway connect"
>
  {@render children()}
</PopupShell>
