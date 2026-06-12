<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import { chatApi } from '$lib/api/chat';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { toast } from 'svelte-sonner';
  import { m } from '$lib/paraglide/messages.js';

  let {
    open = false,
    channel,
    onClose
  }: {
    open?: boolean;
    channel: { id: string; name: string; topic?: string | null } | null;
    onClose: () => void;
  } = $props();

  let name = $state('');
  let topic = $state('');
  let busy = $state(false);

  $effect(() => {
    if (open && channel) {
      name = channel.name;
      topic = channel.topic ?? '';
    }
  });

  function handleOpenChange(next: boolean) {
    if (!next) {
      name = '';
      topic = '';
      busy = false;
      onClose();
    }
  }

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (!channel) return;
    const trimmedName = name.trim().replace(/\s+/g, '-').toLowerCase();
    const newTopic = topic.trim();
    const nameChanged = !!trimmedName && trimmedName !== channel.name;
    const topicChanged = newTopic !== (channel.topic ?? '');
    if (!nameChanged && !topicChanged) {
      onClose();
      return;
    }
    const patch: { name?: string; topic?: string } = {};
    if (nameChanged) patch.name = trimmedName;
    if (topicChanged) patch.topic = newTopic;
    busy = true;
    try {
      const updated = await chatApi.patchChannel(channel.id, patch);
      guilds.updateChannel(updated);
      onClose();
    } catch (err) {
      toast.error(m.rename_channel_dialog_rename_failed(), { description: (err as Error).message });
    } finally {
      busy = false;
    }
  }
</script>

<Dialog.Root {open} onOpenChange={handleOpenChange}>
  <Dialog.Content data-testid="rename-channel-dialog">
    <Dialog.Header>
      <Dialog.Title>{m.rename_channel_dialog_title()}</Dialog.Title>
      <Dialog.Description>{m.rename_channel_dialog_description({ name: channel?.name ?? '' })}</Dialog.Description>
    </Dialog.Header>
    <form class="space-y-4" onsubmit={submit}>
      <div class="space-y-1.5">
        <Label for="rename-channel-name" class="text-muted-foreground text-xs font-semibold uppercase tracking-wide">
          {m.rename_channel_dialog_channel_name_label()}
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
      <div class="space-y-1.5">
        <Label for="rename-channel-topic" class="text-muted-foreground text-xs font-semibold uppercase tracking-wide">
          {m.rename_channel_dialog_topic_label()}
        </Label>
        <Input
          id="rename-channel-topic"
          type="text"
          bind:value={topic}
          maxlength={1024}
          disabled={busy}
          placeholder={m.rename_channel_dialog_topic_placeholder()}
          data-testid="rename-channel-topic"
        />
      </div>
      <Dialog.Footer>
        <Button type="button" variant="ghost" onclick={() => handleOpenChange(false)} disabled={busy}>{m.rename_channel_dialog_cancel()}</Button>
        <Button type="submit" disabled={busy} data-testid="rename-channel-submit">
          {busy ? m.rename_channel_dialog_saving() : m.rename_channel_dialog_rename()}
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
