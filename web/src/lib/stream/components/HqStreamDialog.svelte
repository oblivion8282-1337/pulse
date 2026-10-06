<!--
  HqStreamDialog — wrappt StreamPanel in einen shadcn-svelte Dialog (T3c).

  Wird vom HqStreamButton im VoiceControlBar geöffnet. shadcn-svelte hat
  kein Sheet/Drawer-Primitive im Repo (siehe ui/), deshalb nutzen wir den
  Standard-Dialog mit etwas größerer Max-Breite — der dimmt zwar den
  Hintergrund, aber `closeOnOutsideClick` (Default) lässt den User mit
  einem Klick auf den Backdrop zurück in den Channel.
-->
<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import StreamPanel from './StreamPanel.svelte';
  import { isWindows, isMac } from '$lib/platform/runtime';
  import { m } from '$lib/paraglide/messages.js';

  let {
    open = $bindable(false),
    channelId = null,
    // `slot` is a reserved Svelte attribute name → prop is `streamSlot`.
    streamSlot: slot = 0,
  }: { open?: boolean; channelId?: string | null; streamSlot?: number } = $props();

  // Breiter Dialog nur dort, wo `StreamPanel` zweispaltig wird — also wo es
  // eine In-App-Quellenauswahl gibt (Windows/macOS). Linux wählt die Quelle
  // im Wayland-Portal beim Start, hat den Abschnitt gar nicht und bleibt
  // deshalb bei der schmalen, einspaltigen Form.
  //
  // `min(…, 100vw - 4rem)` statt einer festen Breite: sonst klebte der Dialog
  // auf einem 900-px-Fenster an beiden Rändern. Die Basis-Klasse der
  // Dialog-Komponente deckelt unterhalb von `sm` ohnehin auf 100 % − 2rem.
  const widthClass =
    isWindows() || isMac()
      ? 'sm:max-w-[min(1150px,calc(100vw-4rem))]'
      : 'max-w-2xl sm:max-w-2xl';
</script>

<Dialog.Root bind:open>
  <Dialog.Content
    class="max-h-[88vh] w-full overflow-x-hidden overflow-y-auto {widthClass}"
    data-testid="hq-stream-dialog"
  >
    <Dialog.Header class="sr-only">
      <Dialog.Title>{m.hq_stream_dialog_title()}</Dialog.Title>
      <Dialog.Description>
        {m.hq_stream_dialog_description()}
      </Dialog.Description>
    </Dialog.Header>
    <StreamPanel {channelId} streamSlot={slot} onStarted={() => (open = false)} />
  </Dialog.Content>
</Dialog.Root>
