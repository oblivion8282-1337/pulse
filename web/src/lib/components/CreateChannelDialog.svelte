<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import HashIcon from '@lucide/svelte/icons/hash';
  import Volume2Icon from '@lucide/svelte/icons/volume-2';
  import FolderIcon from '@lucide/svelte/icons/folder';
  import { m } from '$lib/paraglide/messages.js';
  import { serverCapabilities } from '$lib/stores/serverCapabilities.svelte';
  import { activeServer } from '$lib/stores/active-server.svelte';

  let {
    open = false,
    onClose,
    onCreate
  }: {
    open?: boolean;
    onClose: () => void;
    onCreate: (name: string, type: number) => void;
  } = $props();

  // Die Ablage ist eine Instanz-Policy des aktiven Servers (die Cloud hat sie
  // aus — sie nimmt beliebige Dateitypen, die kein Hash-Matching sehen kann).
  // Fehlt der Capability-Eintrag noch, zeigen wir die Option: der Server
  // 404't sie notfalls selbst, und fälschlich fehlende Optionen sind
  // schwerer zu diagnostizieren als eine, die einmal ins Leere greift.
  const dropboxAvailable = $derived(
    serverCapabilities.get(activeServer.serverId)?.dropboxEnabled ?? true
  );

  let name = $state('');
  // 0 = text, 1 = voice, 2 = dropbox (per-guild file storage).
  // The route page handles type=2 by routing to /dropbox/channel
  // instead of POST /channels.
  let type = $state<number>(0);

  // Fällt die Ablage weg, während sie ausgewählt war → zurück auf Text.
  $effect(() => {
    if (!dropboxAvailable && type === 2) type = 0;
  });

  function handleOpenChange(next: boolean) {
    if (!next) {
      name = '';
      type = 0;
      onClose();
    }
  }

  function submit(e: SubmitEvent) {
    e.preventDefault();
    const trimmed = name.trim().replace(/\s+/g, '-').toLowerCase();
    if (!trimmed) return;
    onCreate(trimmed, type);
    name = '';
    type = 0;
  }
</script>

<Dialog.Root {open} onOpenChange={handleOpenChange}>
  <Dialog.Content data-testid="create-channel-dialog">
    <Dialog.Header>
      <Dialog.Title>{m.create_channel_dialog_title()}</Dialog.Title>
      <Dialog.Description>{m.create_channel_dialog_description()}</Dialog.Description>
    </Dialog.Header>
    <form class="space-y-4" onsubmit={submit}>
      <div class="space-y-1.5">
        <Label class="text-muted-foreground text-xs font-semibold uppercase tracking-wide">{m.create_channel_dialog_type_label()}</Label>
        <!-- Spaltenzahl folgt den sichtbaren Optionen — fixes grid-cols-3 ließe ohne
             die Ablage eine leere Zelle stehen. Klassen als Literale: Tailwind findet
             zusammengebaute Namen beim Purgen nicht. -->
        <div class={dropboxAvailable ? 'grid grid-cols-3 gap-2' : 'grid grid-cols-2 gap-2'}>
          <Button
            type="button"
            variant={type === 0 ? 'default' : 'secondary'}
            class="justify-center gap-2"
            onclick={() => (type = 0)}
            data-testid="create-channel-type-text"
          >
            <HashIcon class="size-4" />
            {m.create_channel_dialog_type_text()}
          </Button>
          <Button
            type="button"
            variant={type === 1 ? 'default' : 'secondary'}
            class="justify-center gap-2"
            onclick={() => (type = 1)}
            data-testid="create-channel-type-voice"
          >
            <Volume2Icon class="size-4" />
            {m.create_channel_dialog_type_voice()}
          </Button>
          {#if dropboxAvailable}
            <Button
              type="button"
              variant={type === 2 ? 'default' : 'secondary'}
              class="justify-center gap-2"
              onclick={() => (type = 2)}
              data-testid="create-channel-type-dropbox"
            >
              <FolderIcon class="size-4" />
              {m.create_channel_dialog_type_dropbox()}
            </Button>
          {/if}
        </div>
      </div>
      <div class="space-y-1.5">
        <Label for="create-channel-name" class="text-muted-foreground text-xs font-semibold uppercase tracking-wide">
          {m.create_channel_dialog_name_label()}
        </Label>
        <Input
          id="create-channel-name"
          type="text"
          bind:value={name}
          required
          minlength={1}
          maxlength={64}
          data-testid="create-channel-name"
        />
      </div>
      <Dialog.Footer>
        <Button type="button" variant="ghost" onclick={() => handleOpenChange(false)}>{m.create_channel_dialog_cancel()}</Button>
        <Button type="submit" data-testid="create-channel-submit">{m.create_channel_dialog_submit()}</Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
