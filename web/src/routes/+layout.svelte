<script lang="ts">
  import '../app.css';

  let { children } = $props();
</script>

<svelte:head>
  <title>Discord Clone</title>
</svelte:head>

<div class="min-h-screen">
  {@render children?.()}
</div>
