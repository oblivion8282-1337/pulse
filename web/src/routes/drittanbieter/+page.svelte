<script lang="ts">
  import LegalPage from '$lib/components/LegalPage.svelte';
  import source from '$lib/legal/drittanbieter.md?raw';
</script>

<svelte:head>
  <title>Drittanbieter-Software · Pulse</title>
</svelte:head>

<LegalPage {source} />
