<!--
  Heim-Server: Download der Pulse Server-App.

  Seit dem Selbstbedienungs-Entscheid (2026-09-27) braucht es keine
  Freischaltung und keinen Antrag mehr: Server-App installieren, mit dem
  howispulse.com-Konto einloggen — die Registrierung passiert beim ersten
  Start von selbst. Diese Karte zeigt den Download für das laufende System;
  ohne erkennbare Plattform alle drei.
-->
<script lang="ts">
  import { isLinux, isWindows, isMac } from '$lib/platform/runtime';
  import { m } from '$lib/paraglide/messages.js';
  import DownloadIcon from '@lucide/svelte/icons/download';

  // Download-Ziele — dieselben Pfade, die die CI-Jobs füllen:
  //  - win-build-server.yml → /updates/win-server/ (NSIS + Update-Feed)
  //  - mac-build.yml (build-server-Job) → /downloads/Pulse-Server-latest.dmg
  //  - flatpak.yml → Flatpak-Repo (flatpakref)
  const WIN_URL = 'https://howispulse.com/updates/win-server/Pulse-Server-Setup-latest.exe';
  const DMG_URL = 'https://howispulse.com/downloads/Pulse-Server-latest.dmg';
  const FLATPAKREF = 'https://howispulse.com/flatpak/com.howispulse.PulseServer.flatpakref';

  // Erkannte Plattform zuerst; ohne Signal alle drei (User wählt selbst).
  const showWindows = $derived(isWindows());
  const showMac = $derived(!showWindows && isMac());
  const showFlatpak = $derived(!showWindows && !showMac);
  const showAll = $derived(!showWindows && !showMac && !isLinux());

  const HINT = m.server_app_download_linux_hint();
</script>

<section class="flex flex-col gap-4" data-testid="server-app-download">
  <p class="text-text-muted text-sm">{m.server_app_download_intro()}</p>

  {#if showWindows}
    <div class="flex flex-col gap-2">
      <a
        href={WIN_URL}
        class="bg-primary hover:bg-primary/90 inline-flex w-fit items-center gap-2 rounded-xl px-4 py-2 text-sm font-medium text-white transition-colors"
        data-testid="server-app-download-windows"
      >
        <DownloadIcon class="size-4" />
        {m.server_app_download_windows_btn()}
      </a>
      <p class="text-text-muted text-xs">{HINT}</p>
    </div>
  {:else if showMac}
    <div class="flex flex-col gap-2">
      <a
        href={DMG_URL}
        class="bg-primary hover:bg-primary/90 inline-flex w-fit items-center gap-2 rounded-xl px-4 py-2 text-sm font-medium text-white transition-colors"
        data-testid="server-app-download-mac"
      >
        <DownloadIcon class="size-4" />
        {m.server_app_download_mac_btn()}
      </a>
      <p class="text-text-muted text-xs">{HINT}</p>
    </div>
  {:else if showFlatpak}
    <div class="flex flex-col gap-2">
      <a
        href={FLATPAKREF}
        class="bg-primary hover:bg-primary/90 inline-flex w-fit items-center gap-2 rounded-xl px-4 py-2 text-sm font-medium text-white transition-colors"
        data-testid="server-app-download-linux"
      >
        <DownloadIcon class="size-4" />
        {m.server_app_download_linux_btn()}
      </a>
      <p class="text-text-muted text-xs">{HINT}</p>
    </div>
  {/if}

  {#if showAll}
    <div class="flex flex-col gap-2" data-testid="server-app-download-all">
      <a
        href={WIN_URL}
        class="bg-primary hover:bg-primary/90 inline-flex w-fit items-center gap-2 rounded-xl px-4 py-2 text-sm font-medium text-white transition-colors"
        data-testid="server-app-download-windows"
      >
        <DownloadIcon class="size-4" />
        {m.server_app_download_windows_btn()}
      </a>
      <a
        href={DMG_URL}
        class="border-border text-text-bright hover:bg-bg-hover inline-flex w-fit items-center gap-2 rounded-xl border px-4 py-2 text-sm font-medium transition-colors"
        data-testid="server-app-download-mac"
      >
        <DownloadIcon class="size-4" />
        {m.server_app_download_mac_btn()}
      </a>
      <a
        href={FLATPAKREF}
        class="border-border text-text-bright hover:bg-bg-hover inline-flex w-fit items-center gap-2 rounded-xl border px-4 py-2 text-sm font-medium transition-colors"
        data-testid="server-app-download-linux"
      >
        <DownloadIcon class="size-4" />
        {m.server_app_download_linux_btn()}
      </a>
      <p class="text-text-muted text-xs">{HINT}</p>
    </div>
  {/if}
</section>
