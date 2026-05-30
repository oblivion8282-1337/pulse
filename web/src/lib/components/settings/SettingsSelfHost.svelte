<!--
  Self-Hoster-Tab in den Einstellungen.
  Zwei Sektionen: Antrag einreichen (SelfHostApplication) +
  eigene Instanzen verwalten (MyInstances).
-->
<script lang="ts">
  import SelfHostApplication from '$lib/components/account/SelfHostApplication.svelte';
  import MyInstances from '$lib/components/account/MyInstances.svelte';
  import { m } from '$lib/paraglide/messages.js';
</script>

<div class="flex flex-col gap-8" data-testid="settings-self-host-panel">
  <div class="flex flex-col gap-1">
    <h2 class="text-text-bright text-lg font-semibold">Self-Hoster</h2>
    <p class="text-text-muted text-sm">
      {m.settings_self_host_description()}
    </p>
  </div>

  <SelfHostApplication />
  <MyInstances />
</div>
