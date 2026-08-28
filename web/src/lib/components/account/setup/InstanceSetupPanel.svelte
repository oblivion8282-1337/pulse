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

  let { instance }: { instance: Instance } = $props();

  let base = $derived(
    typeof location !== 'undefined' ? location.origin : 'https://howispulse.com'
  );

</script>

<div
  class="border-border bg-bg-panel/40 mt-1 flex flex-col gap-4 rounded-xl border p-3 text-sm"
  data-testid="instance-setup-panel"
>
  <p class="text-text-base text-xs">{m.instance_setup_intro()}</p>

  <!-- Reihenfolge: die beiden Wege, schnell dann von Hand. Bis 2026-08-28
       standen hier zusätzlich der KI-Assistenten-Block (täuschte einen
       dritten Weg vor) und „Was macht dieser Befehl?" darunter — beide
       entfernt. -->
  <SetupSchnellweg {instance} {base} />
  <SetupManuell {instance} {base} />

  <div class="border-border rounded-xl border p-3">
    <p class="text-text-bright mb-1.5 text-xs font-semibold">{m.instance_setup_prereqs_title()}</p>
    <ul class="text-text-muted flex list-disc flex-col gap-1 pl-4 text-xs">
      <li>{m.instance_setup_prereq_docker()}</li>
      <li>{m.instance_setup_prereq_ports()}</li>
      <li>{m.instance_setup_prereq_dns({ hostname: instance.hostname })}</li>
    </ul>
  </div>
</div>
