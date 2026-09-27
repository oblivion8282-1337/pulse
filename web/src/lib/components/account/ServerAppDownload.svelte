<!--
  Heim-Server: Download der Pulse Server-App.

  Seit dem Selbstbedienungs-Entscheid (2026-09-27) braucht es keine
  Freischaltung und keinen Antrag mehr: Server-App installieren, mit dem
  howispulse.com-Konto einloggen — die Registrierung passiert beim ersten
  Start von selbst. Diese Karte zeigt nur noch den Download.
-->
<script lang="ts">
  import { isLinux } from '$lib/platform/runtime';
  import { m } from '$lib/paraglide/messages.js';
  import DownloadIcon from '@lucide/svelte/icons/download';

  const FLATPAKREF = 'https://howispulse.com/flatpak/com.howispulse.PulseServer.flatpakref';

  // Nur Linux hat ein Server-App-Paket. Auf allem anderen (Windows, macOS,
  // Browser) wäre ein Download-Link tot, deshalb zeigen wir dort den ehrlichen
  // „noch nicht fertig"-Hinweis statt des Linux-Wegs.
  const linuxDownload = $derived(isLinux());
</script>

<section class="flex flex-col gap-4" data-testid="server-app-download">
    <p class="text-text-muted text-sm">{m.server_app_download_intro()}</p>
</section>
