<!--
  Rendert die Bestätigungs-Abfragen aus `confirm.svelte.ts`. Gehört GENAU EINMAL
  ins Wurzel-Layout — jede weitere Einbindung würde jede Frage doppelt zeigen.

  Schliessen über Esc, Klick daneben oder „Abbrechen" gilt als Ablehnung: eine
  Bestätigung muss ausdrücklich sein. Aufbau folgt dem Haus-Muster (Abbrechen
  über `AlertDialog.Cancel`, Bestätigen über einen normalen `Button`) — die
  lokalen Baukasten-Hüllen reichen weder `onOpenChange` noch `onclick` durch.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import * as AlertDialog from '$lib/components/ui/alert-dialog';
  import { Button } from '$lib/components/ui/button';
  import { currentConfirm, settleConfirm, type PendingConfirm } from './confirm.svelte';
  import * as m from '$lib/paraglide/messages';

  let open = $state(false);
  /**
   * Die Frage, die gerade auf dem Schirm steht — der Anker für alles Weitere.
   * Ein eigener Merker statt direkt `currentConfirm()`, damit das Schliessen
   * genau die gezeigte Frage ablehnt und nicht eine, die im selben Wimpernschlag
   * nachgerückt ist. Ausserdem hängt so keiner der beiden Effekte unten von der
   * Reihenfolge des anderen ab.
   */
  let shown = $state<PendingConfirm | null>(null);

  // Neue Frage → zeigen. Bewusst keine Rücksynchronisation (`open = req !== null`):
  // die würde den Dialog sofort wieder aufreissen, wenn der Nutzer ihn schliesst.
  $effect(() => {
    const req = currentConfirm();
    if (!req) return;
    shown = req;
    open = true;
  });

  // Zu, obwohl noch eine Frage auf dem Schirm steht (Esc, Klick daneben,
  // Abbrechen-Knopf) → als Ablehnung werten. `untrack`, weil dieser Effekt nur
  // auf das Schliessen hören soll: läse er `shown` mit, würde ihn schon das
  // Stellen einer Frage wecken — noch bevor der Dialog überhaupt offen ist.
  $effect(() => {
    if (open) return;
    const req = untrack(() => shown);
    if (!req) return;
    shown = null;
    settleConfirm(req, false);
  });

  function decide(ok: boolean): void {
    const req = shown;
    shown = null;
    open = false;
    if (req) settleConfirm(req, ok);
  }
</script>

<AlertDialog.Root bind:open>
  <AlertDialog.Content data-testid="confirm-dialog">
    <AlertDialog.Header>
      <AlertDialog.Title>{shown?.title ?? m.confirm_dialog_title()}</AlertDialog.Title>
      <AlertDialog.Description>{shown?.description ?? ''}</AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel>{shown?.cancelLabel ?? m.confirm_dialog_cancel()}</AlertDialog.Cancel>
      <Button
        variant={shown?.destructive ? 'destructive-solid' : 'default'}
        onclick={() => decide(true)}
        data-testid="confirm-dialog-confirm"
      >
        {shown?.confirmLabel ?? m.confirm_dialog_confirm()}
      </Button>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
