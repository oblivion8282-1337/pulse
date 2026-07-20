<script lang="ts">
  import type { Snippet } from 'svelte';
  import { AlertDialog } from 'bits-ui';
  let { children, ...rest }: { children?: Snippet; [key: string]: unknown } = $props();

  /*
   * z-[60] statt z-50: der AlertDialog ist die Rückfrage-Ebene und muss über
   * allem liegen, auch über einem offenen `Dialog`. Bei gleichem Rang (z-50 ist
   * appweit die sonst oberste Stufe) entschied die DOM-Reihenfolge — „Alle
   * leeren" im Tastatur-Tab öffnete die Abfrage hinter dem Einstellungs-Fenster,
   * wo sie unerreichbar war; da `confirmDialog()` auf die Antwort wartet, wirkte
   * der Knopf tot.
   */
</script>
<AlertDialog.Portal>
  <AlertDialog.Overlay class="fixed inset-0 z-[60] bg-black/60" />
  <AlertDialog.Content
    {...rest}
    class="bg-popover text-popover-foreground fixed left-1/2 top-1/2 z-[60] w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-neutral-700 p-6 shadow-xl"
  >
    {@render children?.()}
  </AlertDialog.Content>
</AlertDialog.Portal>
