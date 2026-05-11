<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import { chatApi } from '$lib/api/chat';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { toast } from 'svelte-sonner';

  let {
    open = false,
    channel,
    onClose
  }: {
    open?: boolean;
    channel: { id: string; name: string } | null;
    onClose: () => void;
  } = $props();

  let name = $state('');
  let busy = $state(false);

  $effect(() => {
    if (open && channel) name = channel.name;
  });

  function handleOpenChange(next: boolean) {
    if (!next) {
      name = '';
      busy = false;
      onClose();
    }
  }

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (!channel) return;
    const trimmed = name.trim().replace(/\s+/g, '-').toLowerCase();
    if (!trimmed || trimmed === channel.name) {
      onClose();
      return;
    }
    busy = true;
    try {
      const updated = await chatApi.patchChannel(channel.id, { name: trimmed });
      guilds.updateChannel(updated);
      onClose();
    } catch (err) {
      toast.error('Umbenennen fehlgeschlagen', { description: (err as Error).message });
    } finally {
      busy = false;
    }
  }
</script>

<Dialog.Root {open} onOpenChange={handleOpenChange}>
  <Dialog.Content data-testid="rename-channel-dialog">
    <Dialog.Header>
      <Dialog.Title>Kanal umbenennen</Dialog.Title>
      <Dialog.Description>Neuen Namen eingeben für #{channel?.name ?? ''}</Dialog.Description>
    </Dialog.Header>
    <form class="space-y-4" onsubmit={submit}>
      <div class="space-y-1.5">
        <Label for="rename-channel-name" class="text-muted-foreground text-xs font-semibold uppercase tracking-wide">
          Kanal-Name
        </Label>
        <Input
          id="rename-channel-name"
          type="text"
          bind:value={name}
          required
          minlength={1}
          maxlength={64}
          disabled={busy}
          data-testid="rename-channel-name"
        />
      </div>
      <Dialog.Footer>
        <Button type="button" variant="ghost" onclick={() => handleOpenChange(false)} disabled={busy}>Abbrechen</Button>
        <Button type="submit" disabled={busy} data-testid="rename-channel-submit">
          {busy ? 'Speichern…' : 'Umbenennen'}
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
