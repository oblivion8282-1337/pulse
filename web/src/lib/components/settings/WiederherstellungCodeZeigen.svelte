<script lang="ts">
  /**
   * Zeigt einen frisch erzeugten Wiederherstellungs-Code EIN einziges Mal
   * (E4, Aufgabe 4). „Fertig" bleibt gesperrt, bis die Nutzerin die dritte
   * Vierergruppe des Codes abgetippt hat — der einzige zuverlässige Beweis,
   * dass sie ihn wirklich notiert hat, statt das Fenster wegzuklicken.
   *
   * Reine Anzeige: der Code selbst kommt fertig erzeugt von der Aufruferin
   * (`WiederherstellungBlock.svelte`) herein und wird hier nirgends geloggt
   * oder sonst irgendwohin geschickt.
   */
  import CopyIcon from '@lucide/svelte/icons/copy';
  import { toast } from 'svelte-sonner';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import FieldLabel from '$lib/components/form/FieldLabel.svelte';
  import { gruppeAn, bestaetigungPasst } from '$lib/krypto/wiederherstellungsBestaetigung.ts';
  import { m } from '$lib/paraglide/messages.js';

  let { code, onFertig }: { code: string; onFertig: () => void } = $props();

  /** Dritte Gruppe (Index 2) — mittendrin, nicht die erste oder letzte, die
   *  am ehesten unbeachtet mitgelesen wird. */
  const PRUEF_INDEX = 2;
  const PRUEF_NUMMER = PRUEF_INDEX + 1;

  let eingabe = $state('');
  const sollGruppe = $derived(gruppeAn(code, PRUEF_INDEX) ?? '');
  const passt = $derived(bestaetigungPasst(code, eingabe, PRUEF_INDEX));

  async function kopieren() {
    try {
      await navigator.clipboard.writeText(code);
      toast.success(m.wiederherstellung_code_kopiert());
    } catch {
      toast.error(m.wiederherstellung_code_kopieren_fehlgeschlagen());
    }
  }
</script>

<div class="flex flex-col gap-3" data-testid="wiederherstellung-code-zeigen">
  <p class="text-text-muted text-sm">{m.wiederherstellung_code_hinweis()}</p>

  <div
    class="bg-bg-input/60 border-border rounded-xl border p-4 text-center font-mono text-lg tracking-widest select-all"
    data-testid="wiederherstellung-code-wert"
  >
    {code}
  </div>

  <Button variant="secondary" size="xs" onclick={kopieren} data-testid="wiederherstellung-code-kopieren" type="button">
    <CopyIcon class="size-3.5" />
    {m.wiederherstellung_code_kopieren()}
  </Button>

  <p class="text-destructive text-xs font-medium">{m.wiederherstellung_code_verlust_hinweis()}</p>

  <div class="space-y-1.5">
    <FieldLabel for="wiederherstellung-bestaetigung" required>
      {m.wiederherstellung_code_bestaetigen_label({ nummer: PRUEF_NUMMER })}
    </FieldLabel>
    <Input
      id="wiederherstellung-bestaetigung"
      bind:value={eingabe}
      autocomplete="off"
      spellcheck="false"
      placeholder={sollGruppe.replace(/./g, '•')}
      class="text-center font-mono tracking-[0.2em] uppercase"
      data-testid="wiederherstellung-bestaetigung-eingabe"
    />
  </div>

  <Button disabled={!passt} onclick={onFertig} data-testid="wiederherstellung-code-fertig" type="button">
    {m.wiederherstellung_code_fertig()}
  </Button>
</div>
