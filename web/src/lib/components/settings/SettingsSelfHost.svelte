<!--
  Self-Hoster-Tab in den Einstellungen.
  Zwei klar getrennte Karten:
    1. App-Hosting  — Stufe 2, eigenes Gerät via separater Server-App
       (nur noch Download/Status: ServerAppDownload — der ANTRAG läuft über
       das vereinte Formular in Karte 2)
    2. Eigener Server — vereintes Antragsformular (VPS + App-Host,
       SelfHostApplication) + MyInstances
-->
<script lang="ts">
  import type { Component } from 'svelte';
  import { onMount } from 'svelte';
  import ServerAppDownload from '$lib/components/account/ServerAppDownload.svelte';
  import SelfHostApplication from '$lib/components/account/SelfHostApplication.svelte';
  import MyInstances from '$lib/components/account/MyInstances.svelte';
  import AppWindowIcon from '@lucide/svelte/icons/app-window';
  import ServerIcon from '@lucide/svelte/icons/server';
  import { m } from '$lib/paraglide/messages.js';
  import { APP_HOSTING_ENABLED } from '$lib/featureFlags';
  import { myAppHostApplications } from '$lib/stores/myAppHostApplications.svelte';

  // Der User ist da, wohin ihn der rote Punkt führen sollte → Punkt löschen.
  // (Gegenstück zu MyInstances, das den Self-Host-Punkt quittiert.)
  onMount(() => myAppHostApplications.acknowledge());

  const SECTION_CLASS =
    'border-border bg-bg-input/40 flex flex-col gap-3 rounded-2xl border p-4';
</script>

{#snippet cardHeader(icon: Component, title: string, subtitle: string)}
  {@const Icon = icon}
  <div class="flex items-start gap-3">
    <span
      class="bg-bg-input text-text-muted flex size-9 shrink-0 items-center justify-center rounded-full"
    >
      <Icon class="size-5" />
    </span>
    <div class="flex flex-col gap-0.5">
      <h3 class="text-text-bright text-sm font-semibold">{title}</h3>
      {#if subtitle}
        <p class="text-text-muted text-xs">{subtitle}</p>
      {/if}
    </div>
  </div>
{/snippet}

{#snippet appBody()}
  <ServerAppDownload />
{/snippet}

{#snippet serverBody()}
  <SelfHostApplication />
  <MyInstances />
{/snippet}

<div class="flex flex-col gap-8" data-testid="settings-self-host-panel">
  <div class="flex flex-col gap-1">
    <h2 class="text-text-bright text-lg font-semibold">{m.settings_dialog_tab_self_host()}</h2>
    <p class="text-text-muted text-sm">{m.settings_self_host_description()}</p>
  </div>

  <!-- App-Hosting (Stufe 2): gehostet wird in der separaten Server-App, hier
       steht nur Antrag + Download. Der Schalter blendet den ganzen Weg aus,
       solange kein Paket für die gängigen Systeme existiert. -->
  {#if APP_HOSTING_ENABLED}
    <section class={SECTION_CLASS} data-testid="self-host-app-section">
      {@render cardHeader(AppWindowIcon, m.local_host_title(), m.self_host_app_subtitle())}
      {@render appBody()}
    </section>
  {/if}

  <!-- Eigener Server (Stufe 3): dauerhafter VPS, braucht Cloud-Freischaltung. -->
  <section class={SECTION_CLASS} data-testid="self-host-server-section">
    {@render cardHeader(ServerIcon, m.self_host_server_title(), m.self_host_application_intro())}
    {@render serverBody()}
  </section>
</div>