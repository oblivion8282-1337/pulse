<!--
  DeviceSichtschutz — was der Steuernde eines Geräts NICHT sehen soll.

  ## Das Leck

  Ein Standplatz-Gerät läuft mit dem Konto seines Besitzers. Wer es übernimmt,
  bekommt Maus und Tastatur — und damit dessen Direktnachrichten,
  Nachrichtenverlauf und Freundesliste. Bei einem Menschen, der zehn Minuten
  bewusst hergibt, ist das seine Entscheidung; bei einem Dauergerät wäre es ein
  Dauerleck (Entwurf §4).

  ## Warum der Riegel hier sitzt und nicht im Server

  Der Entwurf (§6) hat ihn zunächst im Server verortet: die Sitzung weiss, über
  welchen Ausweis sie zustande kam, also könne der Server dieser Verbindung
  Chat, Verlauf und Direktnachrichten verweigern. Beim Bauen zeigte sich, dass
  das die Lücke **nicht schliesst** und zugleich zu viel nimmt:

  * **Zu wenig:** der Nachrichtenverlauf kommt über REST, und eine
    REST-Anfrage trägt keine Verbindung — der Server kann ihr nicht ansehen,
    dass sie von einem gerade ferngesteuerten Rechner kommt. Der Riegel
    verfehlte also genau den Weg, über den ein Steuernder lesen würde.
  * **Zu viel:** ein Riegel, der immer gilt, nähme dem Besitzer den Chat auf
    seinem eigenen Rechner, auch wenn niemand ihn steuert.

  Der Riegel gilt deshalb **genau, solange jemand steuert**, und er sitzt dort,
  wo der Inhalt entsteht: auf dem Schirm. Das ist zugleich die richtige Ebene,
  denn die Gefahr ist eine des Sehens — der Steuernde sieht Pixel, keine
  API-Antworten.

  ## Was er nicht kann

  Er hält niemanden auf, der auf diesem Rechner ohnehin alles darf (den
  Besitzer). Er hält den Steuernden auf, und nur um den geht es: Pulse ist auf
  einem Standplatz-Gerät die einzige offene Tür zu diesem Konto — die Anmeldung
  liegt im Geräte-Speicher, nicht im Browser.
-->
<script lang="ts">
  import EyeOffIcon from '@lucide/svelte/icons/eye-off';
  import { remoteSession } from '$lib/remote/session.svelte';
  import { geraeteAnmeldung } from '$lib/devices/anmeldung.svelte';
  import { activeServer } from '$lib/stores/active-server.svelte';
  import { m } from '$lib/paraglide/messages.js';

  // Nur auf einem eingetragenen Gerät, und nur während einer Übernahme. Beides
  // ist nötig: ein gewöhnlicher Rechner, der zehn Minuten hergegeben wird,
  // bleibt die bewusste Entscheidung seines Besitzers — dort wäre ein
  // Sichtschutz Bevormundung.
  let geraet = $derived(geraeteAnmeldung.fuerServer(activeServer.serverId));
  let show = $derived(
    !!geraet && remoteSession.phase === 'active' && remoteSession.role === 'host',
  );
</script>

{#if show}
  <!-- Unter dem Fernsteuer-Banner (z-60), über allem anderen. Der Host soll
       jederzeit sehen und beenden können, was gerade läuft — der Sichtschutz
       darf die Notbremse nicht verdecken. -->
  <div
    class="bg-bg-base/95 fixed inset-0 z-[50] flex flex-col items-center justify-center gap-4
      p-8 text-center backdrop-blur-xl"
    role="status"
    data-testid="device-sichtschutz"
  >
    <span class="text-text-muted grid size-14 place-items-center rounded-xl border border-current/30">
      <EyeOffIcon class="size-7" />
    </span>
    <h2 class="text-text-bright text-lg font-semibold">{m.device_sichtschutz_title()}</h2>
    <p class="text-text-muted max-w-md text-sm">{m.device_sichtschutz_body()}</p>
  </div>
{/if}
