<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import InviteFriendPicker from './InviteFriendPicker.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let {
    open = false,
    guildId,
    onClose
  }: {
    open?: boolean;
    guildId: string;
    onClose: () => void;
  } = $props();

  function onDialogClose() {
    onClose();
  }
</script>

<Dialog.Root {open} onOpenChange={(v) => { if (!v) onDialogClose(); }}>
  <Dialog.Content data-testid="invite-dialog" class="max-w-lg">
    <Dialog.Header>
      <Dialog.Title>{m.invite_dialog_title()}</Dialog.Title>
      <Dialog.Description>{m.invite_dialog_description_new()}</Dialog.Description>
    </Dialog.Header>

    <div class="space-y-4">
      {#if guildId}
        <InviteFriendPicker {guildId} />
      {:else}
        <p class="text-text-muted text-sm">{m.invite_dialog_no_guild()}</p>
      {/if}
    </div>

    <Dialog.Footer>
      <Button variant="ghost" onclick={onDialogClose}>{m.invite_dialog_close_btn()}</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
