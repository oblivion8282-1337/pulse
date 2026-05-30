<script lang="ts">
  import LegalPage from '$lib/components/LegalPage.svelte';
  import source from '$lib/legal/datenschutz.md?raw';
  import { m } from '$lib/paraglide/messages.js';
</script>

<svelte:head>
  <title>{m.datenschutz_page_title()}</title>
</svelte:head>

<LegalPage {source} />
