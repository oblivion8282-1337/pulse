<!--
  Die Einrichtung einer Instanz — aufgeklappt in der Liste, nicht als Dialog.

  Bis 2026-08-27 war das ein `Dialog.Root` (`InstanceSetupDialog.svelte`). Ein
  Dialog legt sich über die Liste, aus der er kommt: Man sieht nicht mehr, zu
  welcher Zeile er gehört, und auf schmalen Geräten füllt er ohnehin den
  Bildschirm — dann ist er ein Bildschirmwechsel, der sich nur nicht so nennt.
  Aufgeklappt bleibt die Zeile darüber stehen.

  Bewusst KEIN eigenes Aufräumen beim Schließen: die Zeile hängt das Stück
  aus, damit ist der Zustand (Token, Countdown) weg. Der Dialog musste das von
  Hand nachbauen und brauchte dafür einen Generations-Wächter, weil er
  zwischen Instanzen umschaltete statt neu zu entstehen.
-->
<script lang="ts">
  import { m } from '$lib/paraglide/messages.js';
  import type { Instance } from '$lib/api/instances';
  import SetupSchnellweg from './SetupSchnellweg.svelte';
  import SetupManuell from './SetupManuell.svelte';
  import SetupKiHilfe from './SetupKiHilfe.svelte';
  import SetupErklaerung from './SetupErklaerung.svelte';

  let { instance }: { instance: Instance } = $props();

  let base = $derived(
    typeof location !== 'undefined' ? location.origin : 'https://howispulse.com'
  );

  // Der Befehl entsteht im Schnellweg (dort wird das Token gemintet), gebraucht
  // wird er auch von der KI-Hilfe weiter unten. Er reist deshalb hier durch,
  // statt das Token ein zweites Mal auszustellen — jedes Ausstellen rotiert
  // serverseitig das Secret und entwertet das vorherige.
  let befehl = $state('');
</script>

<div
  class="border-border bg-bg-panel/40 mt-1 flex flex-col gap-4 rounded-xl border p-3 text-sm"
  data-testid="instance-setup-panel"
>
  <p class="text-text-base text-xs">{m.instance_setup_intro()}</p>

  <!-- Reihenfolge: die beiden ECHTEN Wege zuerst (schnell, dann von Hand),
       danach die Hilfe zu ihnen und das Kleingedruckte. -->
  <SetupSchnellweg {instance} {base} bind:befehl />
  <SetupManuell {instance} {base} />
  <SetupKiHilfe {befehl} {base} />
  <SetupErklaerung {base} />

  <div class="border-border rounded-xl border p-3">
    <p class="text-text-bright mb-1.5 text-xs font-semibold">{m.instance_setup_prereqs_title()}</p>
    <ul class="text-text-muted flex list-disc flex-col gap-1 pl-4 text-xs">
      <li>{m.instance_setup_prereq_docker()}</li>
      <li>{m.instance_setup_prereq_ports()}</li>
      <li>{m.instance_setup_prereq_dns({ hostname: instance.hostname })}</li>
    </ul>
  </div>
</div>
