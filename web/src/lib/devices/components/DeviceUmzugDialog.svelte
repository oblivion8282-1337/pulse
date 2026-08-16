<!--
  Nachfrage vor dem Umstellen eines BELEGTEN Standplatz-Geräts.

  Ein Standplatzwechsel beendet eine laufende Fernsteuerung — der Server tut
  das, weil die Rechte am alten Kanal hingen. Für den Besitzer, der eine Zeile
  in einen anderen Kanal zieht, ist das nicht abzusehen: er ordnet um, und
  jemand anderem bricht dabei die Sitzung ab. Deshalb dieselbe Form wie bei den
  übrigen abbrechenden Handlungen im Projekt (`AlertDialog`, roter Bestätigen-
  Knopf), statt einer Meldung hinterher.

  Steht das Gerät auf `ready` oder `offline`, erscheint dieser Dialog nie — dort
  gibt es nichts zu unterbrechen, und eine Rückfrage wäre nur eine Bremse
  (`umzug.svelte.ts`).
-->
<script lang="ts">
  import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
  import { geraeteUmzug } from '$lib/devices/umzug.svelte';
  import { m } from '$lib/paraglide/messages.js';

  const nachfrage = $derived(geraeteUmzug.nachfrage);
  const offen = $derived(nachfrage !== null);
</script>

<AlertDialog.Root bind:open={() => offen, (v: boolean) => { if (!v) geraeteUmzug.abbrechen(); }}>
  <AlertDialog.Content data-testid="device-move-dialog">
    <AlertDialog.Header>
      <AlertDialog.Title>{m.device_move_busy_title()}</AlertDialog.Title>
      <AlertDialog.Description>
        {m.device_move_busy_body({
          device: nachfrage?.geraet.name ?? '',
          channel: nachfrage?.ziel.name ?? ''
        })}
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <!-- Schließen (Abbrechen/ESC) läuft über den bind-Setter → abbrechen(). -->
      <AlertDialog.Cancel disabled={geraeteUmzug.laeuft}>{m.device_move_cancel()}</AlertDialog.Cancel>
      <AlertDialog.Action
        onclick={() => void geraeteUmzug.bestaetigen()}
        disabled={geraeteUmzug.laeuft}
        data-testid="device-move-confirm"
      >
        {m.device_move_busy_confirm()}
      </AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
