<!--
  SettingsStandplatzFreigabe — die Freigabeliste dieses Standplatz-Geräts im
  Reiter.

  Dünner Wrapper um `DeviceFreigaben` (Aufgabe 9, `$lib/devices/components/`):
  die Freigabe-Oberfläche für Standplatz-Geräte gibt es damit EINMAL, nicht
  zweimal — vorher stand hier eine zweite, ältere Fassung, die
  `standplatz.nutzer`/`jeder` bearbeitete.

  **Warum das kein Verhaltensbruch ist, obwohl die alte Liste verschwindet.**
  Seit 2026-08-20 entscheidet für die WEM-Frage allein der Server
  (`device_grants`, Begründung im Dateikopf von `remote/standplatz.svelte.ts`)
  — `standplatz.nutzer`/`jeder` sind seither nur noch Umzugsvorrat für zwei
  andere Oberflächen (`RemoteStandplatzBanner`, `RemoteConsentDialog`, Umbau
  in einer eigenen, nachfolgenden Aufgabe) und keine Quelle der Wahrheit mehr.
  Ihre Setzer bleiben deshalb bestehen, nur diese Datei hängt nicht mehr daran.
-->
<script lang="ts">
  import DeviceFreigaben from '$lib/devices/components/DeviceFreigaben.svelte';
  import type { Device } from '$lib/api/devices';

  let { device }: { device: Device | null } = $props();
</script>

{#if device}
  <DeviceFreigaben {device} />
{/if}
