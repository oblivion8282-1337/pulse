<!--
  SettingsApps — „Apps"-Tab in den Einstellungen: Download-Karten für die
  Desktop-Apps (Windows-Installer, Linux-Flatpak) und die Android-APK.

  Der Tab wird in SettingsDialog nur im Browser angeboten (in Electron /
  im Android-Wrapper ausgeblendet — dort ist die App schon installiert).
  Linux zeigt die Anleitung direkt inline statt eines Popovers.
-->
<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import CheckIcon from '@lucide/svelte/icons/check';
  import CopyIcon from '@lucide/svelte/icons/copy';
  import DownloadIcon from '@lucide/svelte/icons/download';
  import WindowsIcon from '$lib/components/brand-icons/WindowsIcon.svelte';
  import LinuxIcon from '$lib/components/brand-icons/LinuxIcon.svelte';
  import AndroidIcon from '$lib/components/brand-icons/AndroidIcon.svelte';
  import {
    WINDOWS_INSTALLER_URL,
    ANDROID_APK_URL,
    LINUX_FLATPAKREF_URL,
    LINUX_INSTALL_COMMAND
  } from '$lib/downloads/appDownloads';
  import { m } from '$lib/paraglide/messages.js';

  let copied = $state(false);
  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(LINUX_INSTALL_COMMAND);
      copied = true;
      setTimeout(() => (copied = false), 2000);
    } catch {
      // Clipboard verweigert (Permissions) — der Befehl steht ja sichtbar da.
    }
  }
</script>

<div class="flex flex-col gap-5" data-testid="settings-apps-panel">
  <div class="flex flex-col gap-1">
    <h2 class="text-text-bright text-base font-semibold">{m.settings_apps_heading()}</h2>
    <p class="text-text-muted text-xs">{m.settings_apps_intro()}</p>
  </div>

  <!-- Windows -->
  <div class="border-border flex flex-col gap-3 rounded-2xl border p-4">
    <div class="flex items-center gap-3">
      <span class="bg-bg-input text-text-muted flex size-10 shrink-0 items-center justify-center rounded-full">
        <WindowsIcon class="size-5" />
      </span>
      <div class="min-w-0 flex-1">
        <p class="text-text-bright text-sm font-medium">{m.downloads_windows()}</p>
        <p class="text-text-muted text-xs">{m.settings_apps_windows_desc()}</p>
      </div>
    </div>
    <Button href={WINDOWS_INSTALLER_URL} variant="secondary" size="sm" class="gap-1.5 self-start">
      <DownloadIcon class="size-3.5" />
      {m.settings_apps_download()}
    </Button>
  </div>

  <!-- Linux (Flatpak) -->
  <div class="border-border flex flex-col gap-3 rounded-2xl border p-4">
    <div class="flex items-center gap-3">
      <span class="bg-bg-input text-text-muted flex size-10 shrink-0 items-center justify-center rounded-full">
        <LinuxIcon class="size-5" />
      </span>
      <div class="min-w-0 flex-1">
        <p class="text-text-bright text-sm font-medium">{m.downloads_linux_title()}</p>
        <p class="text-text-muted text-xs">{m.downloads_linux_step_terminal()}</p>
      </div>
    </div>
    <code class="bg-bg-input block select-all break-all rounded-md px-2 py-1.5 font-mono text-2xs">
      {LINUX_INSTALL_COMMAND}
    </code>
    <Button type="button" variant="secondary" size="sm" class="gap-1.5 self-start" onclick={copyCommand}>
      {#if copied}
        <CheckIcon class="size-3.5" />
        {m.downloads_linux_copied()}
      {:else}
        <CopyIcon class="size-3.5" />
        {m.downloads_linux_copy()}
      {/if}
    </Button>
    <p class="text-text-muted text-xs">
      {m.downloads_linux_or_software()}
      <a href={LINUX_FLATPAKREF_URL} class="text-primary hover:underline">
        {m.downloads_linux_flatpakref()}
      </a>
    </p>
  </div>

  <!-- Android -->
  <div class="border-border flex flex-col gap-3 rounded-2xl border p-4">
    <div class="flex items-center gap-3">
      <span class="bg-bg-input text-text-muted flex size-10 shrink-0 items-center justify-center rounded-full">
        <AndroidIcon class="size-5" />
      </span>
      <div class="min-w-0 flex-1">
        <p class="text-text-bright text-sm font-medium">{m.downloads_android()}</p>
        <p class="text-text-muted text-xs">{m.settings_apps_android_desc()}</p>
      </div>
    </div>
    <Button href={ANDROID_APK_URL} variant="secondary" size="sm" class="gap-1.5 self-start">
      <DownloadIcon class="size-3.5" />
      {m.settings_apps_download()}
    </Button>
  </div>
</div>
