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
  import { m } from '$lib/paraglide/messages.js';

  let { open = $bindable(false), channelId = null }: { open?: boolean; channelId?: string | null } =
    $props();
</script>

<Dialog.Root bind:open>
  <Dialog.Content
    class="max-h-[85vh] max-w-2xl overflow-y-auto"
    data-testid="hq-stream-dialog"
  >
    <Dialog.Header class="sr-only">
      <Dialog.Title>{m.hq_stream_dialog_title()}</Dialog.Title>
      <Dialog.Description>
        {m.hq_stream_dialog_description()}
      </Dialog.Description>
    </Dialog.Header>
    <StreamPanel {channelId} onStarted={() => (open = false)} />
  </Dialog.Content>
</Dialog.Root>
