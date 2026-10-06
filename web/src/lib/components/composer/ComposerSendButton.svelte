<!--
  Der Absende-Knopf — eigene Datei, seit `MessageInput.svelte` bei der
  Anhang-Etappe geteilt wurde. Unveraendert uebernommen, dieselbe
  `data-testid`.

  Drei beabsichtigte Abweichungen von der Standard-Variante:
  Grösse: `md:size-9` (36px) zieht mit Büroklammer und Emoji daneben gleich,
  vorher war dieser eine Knopf 32px. `size-10` (40px) auf dem Handy:
  kompakte Zeilenhöhe mit ausreichender Trefferfläche.
  Verlauf: `accent-gradient` statt der einfarbigen Fläche — direkt unter den
  eigenen (blauen) Sprechblasen hob sich ein flaches `bg-primary` nicht vom
  Umfeld ab; der leichte Schatten unterstützt das.
  Gesperrt: die Basis blendet auf 50 % aus, was einen blassblauen Geist ergab.
  `disabled:opacity-100` hebt das auf, erst dadurch werden
  `disabled:bg-secondary`/`disabled:text-text-muted` sichtbar — eine echte
  graue Fläche statt „halb da". Die Abweichungen gehören zusammen.
-->
<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import MicIcon from '@lucide/svelte/icons/mic';
  import SendHorizontalIcon from '@lucide/svelte/icons/send-horizontal';
  import { m } from '$lib/paraglide/messages.js';

  let {
    disabled = false,
    mikro = false,
    onMikrofon
  }: {
    disabled?: boolean;
    /** Wahr = Nachrichtenzeile leer und nicht im Fokus: der Knopf zeigt das
     *  MIKROFON (Tippen startet die Sprachaufnahme) statt des Sendens. */
    mikro?: boolean;
    onMikrofon?: () => void;
  } = $props();
</script>

{#if mikro && onMikrofon}
  <Button
    type="button"
    variant="ghost"
    size="icon"
    class="text-text-muted hover:text-text-bright size-10 md:size-9"
    onclick={onMikrofon}
    aria-label={m.message_input_hold_to_speak()}
    data-testid="voice-record-button"
  >
    <MicIcon class="size-5" />
  </Button>
{:else}
  <Button
    type="submit"
    size="icon"
    class="accent-gradient size-10 text-white shadow-[0_4px_14px_rgba(37,99,235,0.35)] hover:brightness-110 disabled:bg-none disabled:bg-secondary disabled:text-text-muted disabled:opacity-100 disabled:shadow-none md:size-9"
    {disabled}
    data-testid="message-send"
    aria-label={m.message_input_send()}
  >
    <SendHorizontalIcon />
  </Button>
{/if}
