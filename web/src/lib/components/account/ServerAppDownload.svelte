<!--
  App-Hosting: Download der Pulse Server-App.

  Ersetzt das frühere In-Client-Hosting (LocalHosting.svelte). Der Client
  startet keinen Server mehr selbst: er konnte den Router nicht öffnen
  (Fritz!Box ohne UPnP-Schreibrecht) und teilte sich den Container-Namen mit
  der Server-App. Gehostet wird ausschließlich in der separaten Server-App;
  ihre Medien lochen sich per WebRTC selbst durch das NAT.

  Gesperrter Zustand (Konto nicht freigeschaltet) → Antrag stellen.
  Freigeschaltet → Download für das laufende System.
-->
<script lang="ts">
  import { auth } from '$lib/stores/auth.svelte';
  import { myAppHostApplications } from '$lib/stores/myAppHostApplications.svelte';
  import AppHostApplicationDialog from './AppHostApplicationDialog.svelte';
  import { isLinux } from '$lib/platform/runtime';
  import { m } from '$lib/paraglide/messages.js';
  import DownloadIcon from '@lucide/svelte/icons/download';

  const FLATPAKREF = 'https://howispulse.com/flatpak/com.howispulse.PulseServer.flatpakref';

  const myPendingApp = $derived(
    myAppHostApplications.applications.find((a) => a.status === 'pending') ?? null
  );
  const myLastRejected = $derived(
    myAppHostApplications.applications.find((a) => a.status === 'rejected') ?? null
  );

  const locked = $derived(auth.user?.self_host_enabled === false);

  // Nur Linux hat ein Server-App-Paket. Auf allem anderen (Windows, macOS,
  // Browser) wäre ein Download-Link tot, deshalb zeigen wir dort den ehrlichen
  // „noch nicht fertig"-Hinweis statt des Linux-Wegs.
  const linuxDownload = $derived(isLinux());
</script>

<section class="flex flex-col gap-4" data-testid="server-app-download">
  {#if locked}
    <div class="flex flex-col gap-3" data-testid="local-host-locked">
      {#if myPendingApp}
        <p class="text-text-bright text-sm font-medium">{m.local_host_locked_pending_title()}</p>
        <p class="text-text-muted text-sm">{m.local_host_locked_pending_body()}</p>
      {:else if myLastRejected}
        <p class="text-text-bright text-sm font-medium">{m.local_host_locked_rejected_title()}</p>
        <p class="text-text-muted text-sm">
          {m.local_host_locked_rejected_body({ reason: myLastRejected.rejection_reason ?? '' })}
        </p>
        <div><AppHostApplicationDialog /></div>
      {:else}
        <p class="text-text-bright text-sm font-medium">{m.local_host_locked_title()}</p>
        <p class="text-text-muted text-sm">{m.local_host_locked_body()}</p>
        <div><AppHostApplicationDialog /></div>
      {/if}
    </div>
  {:else}
    <p class="text-text-muted text-sm">{m.server_app_download_intro()}</p>

    {#if linuxDownload}
      <div class="flex flex-col gap-2">
        <a
          href={FLATPAKREF}
          class="bg-primary hover:bg-primary/90 inline-flex w-fit items-center gap-2 rounded-xl px-4 py-2 text-sm font-medium text-white transition-colors"
          data-testid="server-app-download-linux"
        >
          <DownloadIcon class="size-4" />
          {m.server_app_download_linux_btn()}
        </a>
        <p class="text-text-muted text-xs">{m.server_app_download_linux_hint()}</p>
      </div>
    {:else}
      <p class="text-text-muted text-sm" data-testid="server-app-download-soon">
        {m.server_app_download_soon()}
      </p>
    {/if}
  {/if}
</section>
