<!--
  DeviceKiosk — was ein eingetragenes Gerät dauerhaft tun muss, damit es
  erreichbar bleibt. Rendert nichts.

  **Der Bildschirm darf nicht ausgehen.** Die Aufnahme braucht eine Ausgabe:
  Windows Graphics Capture liefert kein Bild ohne angeschlossenen, aktiven
  Schirm (Entwurf §10). Bei einem Rechner, vor dem jemand sitzt, hält der
  Mensch den Schirm wach; bei einem Standplatz-Gerät rührt sich tagelang
  niemand, und die Energieverwaltung schaltet ab. Beim ersten Weckruf käme dann
  Schwarzbild, und der Fehler sähe aus wie ein Encoder-Problem.

  Genutzt wird dieselbe Sperre, die auch das Zuschauen offenhält
  (`$lib/platform/wakeLock`) — sie ist gezählt, ein zweiter Halter stört also
  nicht. Unter Electron führt sie auf `powerSaveBlocker`
  ('prevent-display-sleep'): nur der Monitor, die Maschine darf weiter
  schlafen, wenn jemand den Deckel schliesst.

  **Was sie NICHT kann**, und was deshalb im Betriebssystem eingestellt werden
  muss (`docs/2026-08-16-standplatz-geraet-einrichten.md`):

  * Sie hält die Sperre nur, solange das Fenster sichtbar ist — ein minimiertes
    Pulse lässt den Schirm schlafen.
  * Sie verhindert kein **Sperren** des Bildschirms. Auf dem Sperrbildschirm
    existiert der Sidecar gar nicht; das ist die harte Grenze aus §10 und mit
    einem Userland-Prozess nicht zu umgehen.
-->
<script lang="ts">
  import { acquireWakeLock } from '$lib/platform/wakeLock';
  import { geraeteAnmeldung } from '$lib/devices/anmeldung.svelte';
  import { activeServer } from '$lib/stores/active-server.svelte';
  import { isElectron } from '$lib/platform/runtime';

  const desktop = isElectron();

  $effect(() => {
    // Nur auf einem eingetragenen Gerät und nur in der Desktop-App: im Browser
    // gibt es keinen Sidecar, den ein wacher Schirm etwas anginge.
    if (!desktop || !geraeteAnmeldung.fuerServer(activeServer.serverId)) return;
    return acquireWakeLock();
  });
</script>
