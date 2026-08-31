<script lang="ts">
  /**
   * Der zweite der drei Wege (E4, Aufgabe 4): auf einem neuen Gerät den
   * notierten Code eingeben und die Verbindungen des Archivs zurückholen.
   *
   * Die drei Fehlerfälle aus dem Auftrag werden hier NICHT selbst
   * unterschieden — das übernimmt `krypto/wiederherstellung.svelte.ts::loeseEin`
   * über `EinloeseFehler.fall`. Diese Komponente übersetzt nur noch den Fall
   * in einen Text.
   */
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import FieldLabel from '$lib/components/form/FieldLabel.svelte';
  import * as Alert from '$lib/components/ui/alert/index.js';
  import OctagonXIcon from '@lucide/svelte/icons/octagon-x';
  import { loeseEin, EinloeseFehler, type EinloeseFall } from '$lib/krypto/wiederherstellung.svelte.ts';
  import { m } from '$lib/paraglide/messages.js';

  let {
    open = $bindable(false),
    onWiederhergestellt,
  }: { open?: boolean; onWiederhergestellt: (anzahl: number) => void } = $props();

  let code = $state('');
  let busy = $state(false);
  let error = $state<string | null>(null);

  $effect(() => {
    if (!open) {
      code = '';
      busy = false;
      error = null;
    }
  });

  function meldungFuer(fall: EinloeseFall): string {
    switch (fall) {
      case 'codeFalsch':
        return m.wiederherstellung_einloesen_fehler_code_falsch();
      case 'keinPaeckchen':
        return m.wiederherstellung_einloesen_fehler_kein_paeckchen();
      case 'nichtErreichbar':
        return m.wiederherstellung_einloesen_fehler_nicht_erreichbar();
    }
  }

  async function submit(e: Event) {
    e.preventDefault();
    if (busy) return;
    busy = true;
    error = null;
    try {
      const { anzahl } = await loeseEin(code);
      open = false;
      onWiederhergestellt(anzahl);
    } catch (err) {
      error = err instanceof EinloeseFehler ? meldungFuer(err.fall) : m.wiederherstellung_einloesen_fehler_unbekannt();
    } finally {
      busy = false;
    }
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Portal>
    <Dialog.Overlay />
    <Dialog.Content data-testid="wiederherstellung-einloesen-dialog" class="max-w-md">
      <Dialog.Header>
        <Dialog.Title>{m.wiederherstellung_einloesen_titel()}</Dialog.Title>
        <Dialog.Description>{m.wiederherstellung_einloesen_beschreibung()}</Dialog.Description>
      </Dialog.Header>

      <form onsubmit={submit} class="space-y-3">
        <div class="space-y-1.5">
          <FieldLabel for="wiederherstellung-code-eingabe" required>
            {m.wiederherstellung_einloesen_label()}
          </FieldLabel>
          <Input
            id="wiederherstellung-code-eingabe"
            bind:value={code}
            required
            autocomplete="off"
            spellcheck="false"
            class="text-center font-mono tracking-[0.2em] uppercase"
            data-testid="wiederherstellung-einloesen-eingabe"
          />
        </div>

        {#if error}
          <Alert.Root variant="destructive" data-testid="wiederherstellung-einloesen-fehler">
            <OctagonXIcon />
            <Alert.Description>{error}</Alert.Description>
          </Alert.Root>
        {/if}

        <Dialog.Footer>
          <Button variant="ghost" type="button" onclick={() => (open = false)} disabled={busy}>
            {m.wiederherstellung_einloesen_abbrechen()}
          </Button>
          <Button type="submit" disabled={busy} data-testid="wiederherstellung-einloesen-submit">
            {busy ? m.wiederherstellung_einloesen_laedt() : m.wiederherstellung_einloesen_submit()}
          </Button>
        </Dialog.Footer>
      </form>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
