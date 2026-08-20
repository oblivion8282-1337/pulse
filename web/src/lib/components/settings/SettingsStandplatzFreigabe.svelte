<!--
  SettingsStandplatzFreigabe — die Freigabeliste dieses Standplatz-Geräts im
  Reiter.

  Dünner Wrapper um `DeviceFreigaben` (Aufgabe 9, `$lib/devices/components/`):
  die Freigabe-Oberfläche für Standplatz-Geräte gibt es damit EINMAL, nicht
  zweimal — vorher stand hier eine zweite, ältere Fassung, die
  `standplatz.nutzer`/`jeder` bearbeitete.

  **Warum das kein Verhaltensbruch ist, obwohl die alte Liste verschwindet.**
  Seit 2026-08-20 entscheidet für die WEM-Frage allein der Server
  (`device_grants`, Begründung im Dateikopf von `remote/standplatz.svelte.ts`).
  `RemoteStandplatzBanner` und `RemoteConsentDialog` hingen als letzte noch an
  `standplatz.nutzer`/`jeder` — beide schreiben inzwischen ebenfalls auf die
  Server-Liste, die Felder samt ihren Setzern (`nutzerErgaenzen`/`nutzerSetzen`)
  sind aus `standplatz.svelte.ts` entfernt.
-->
<script lang="ts">
  import DeviceFreigaben from '$lib/devices/components/DeviceFreigaben.svelte';
  import type { Device } from '$lib/api/devices';

  let { device }: { device: Device | null } = $props();
</script>

{#if device}
  <DeviceFreigaben {device} />
{/if}
