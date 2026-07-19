<!--
  AppDownloadLinks — dezente Download-Leiste für die App-Pakete
  (Windows-Installer, Linux-Flatpak, Android-APK) auf dem Login-Screen.

  Nur im Browser sichtbar: in der Electron-App und im Android-Wrapper
  rendert die Komponente nichts (dort ist die App ja schon installiert).
  Das erkannte OS steht vorn. Windows/Android sind Direkt-Downloads,
  Linux öffnet ein kleines Popout mit dem flatpak-Befehl (ein nackter
  .flatpakref-Download wäre für die meisten verwirrend).
-->
<script lang="ts">
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import CheckIcon from '@lucide/svelte/icons/check';
  import CopyIcon from '@lucide/svelte/icons/copy';
  import WindowsIcon from './brand-icons/WindowsIcon.svelte';
  import LinuxIcon from './brand-icons/LinuxIcon.svelte';
  import AndroidIcon from './brand-icons/AndroidIcon.svelte';
  import AppleIcon from './brand-icons/AppleIcon.svelte';
  import { isElectron, isCapacitorAndroid, isLinux, isWindows, isMac } from '$lib/platform/runtime';
  import {
    WINDOWS_INSTALLER_URL,
    MAC_DMG_URL,
    ANDROID_APK_URL,
    LINUX_FLATPAKREF_URL,
    LINUX_INSTALL_COMMAND
  } from '$lib/downloads/appDownloads';
  import { m } from '$lib/paraglide/messages.js';

  const visible = !isElectron() && !isCapacitorAndroid();

  const isAndroidBrowser =
    typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent);

  // Erkanntes OS zuerst — die übrigen behalten ihre Reihenfolge.
  type Platform = 'windows' | 'mac' | 'linux' | 'android';
  const order: Platform[] = (() => {
    const base: Platform[] = ['windows', 'mac', 'linux', 'android'];
    const detected: Platform | null = isAndroidBrowser
      ? 'android'
      : isWindows()
        ? 'windows'
        : isMac()
          ? 'mac'
          : isLinux()
            ? 'linux'
            : null;
    if (!detected) return base;
    return [detected, ...base.filter((p) => p !== detected)];
  })();

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

  const linkClass =
    'bg-secondary/60 text-secondary-foreground hover:bg-secondary flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors';
</script>

{#if visible}
  <div
    class="bg-card/85 border-border/60 flex flex-wrap items-center justify-center gap-2 rounded-xl border px-3 py-2 shadow-lg backdrop-blur"
    data-testid="app-download-links"
  >
    <span class="text-card-foreground/80 text-xs font-medium">{m.downloads_get_apps()}</span>
    {#each order as platform (platform)}
      {#if platform === 'windows'}
        <a
          href={WINDOWS_INSTALLER_URL}
          class={linkClass}
          title={m.downloads_windows_hint()}
          data-testid="download-windows"
        >
          <WindowsIcon class="size-3.5" />
          {m.downloads_windows()}
        </a>
      {:else if platform === 'mac'}
        <a
          href={MAC_DMG_URL}
          class={linkClass}
          title={m.downloads_mac_hint()}
          data-testid="download-mac"
        >
          <AppleIcon class="size-3.5" />
          {m.downloads_mac()}
        </a>
      {:else if platform === 'android'}
        <a
          href={ANDROID_APK_URL}
          class={linkClass}
          title={m.downloads_android_hint()}
          data-testid="download-android"
        >
          <AndroidIcon class="size-3.5" />
          {m.downloads_android()}
        </a>
      {:else}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger>
            {#snippet child({ props })}
              <button type="button" {...props} class={linkClass} data-testid="download-linux">
                <LinuxIcon class="size-3.5" />
                {m.downloads_linux()}
              </button>
            {/snippet}
          </DropdownMenu.Trigger>
          <DropdownMenu.Content class="w-80 p-3" side="top">
            <p class="text-foreground text-sm font-semibold">{m.downloads_linux_title()}</p>
            <p class="text-muted-foreground mt-2 text-xs">{m.downloads_linux_step_terminal()}</p>
            <code
              class="bg-muted mt-1 block select-all break-all rounded-md px-2 py-1.5 font-mono text-2xs"
            >
              {LINUX_INSTALL_COMMAND}
            </code>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              class="mt-2 w-full gap-1.5"
              onclick={copyCommand}
            >
              {#if copied}
                <CheckIcon class="size-3.5" />
                {m.downloads_linux_copied()}
              {:else}
                <CopyIcon class="size-3.5" />
                {m.downloads_linux_copy()}
              {/if}
            </Button>
            <p class="text-muted-foreground mt-3 text-xs">{m.downloads_linux_or_software()}</p>
            <a
              href={LINUX_FLATPAKREF_URL}
              class="text-primary mt-1 inline-block text-xs hover:underline"
            >
              {m.downloads_linux_flatpakref()}
            </a>
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      {/if}
    {/each}
  </div>
{/if}
