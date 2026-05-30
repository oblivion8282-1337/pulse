<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { toast } from 'svelte-sonner';
  import { chatApi } from '$lib/api/chat';
  import type { Invite } from '$lib/api/types';
  import InviteListItem from './InviteListItem.svelte';
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

  let invite = $state<Invite | null>(null);
  let invites = $state<Invite[]>([]);
  let busy = $state(false);
  let expiresInSeconds = $state<number | undefined>(undefined);
  let maxUses = $state<number | undefined>(undefined);

  $effect(() => {
    if (open) {
      generateInvite();
    } else {
      invite = null;
      invites = [];
      expiresInSeconds = undefined;
      maxUses = undefined;
    }
  });

  const EXPIRE_OPTIONS = $derived([
    { value: '', label: m.invite_dialog_expire_never() },
    { value: '3600', label: m.invite_dialog_expire_1h() },
    { value: '86400', label: m.invite_dialog_expire_1d() },
    { value: '604800', label: m.invite_dialog_expire_7d() }
  ]);
  const USES_OPTIONS = $derived([
    { value: '', label: m.invite_dialog_uses_unlimited() },
    { value: '1', label: '1' },
    { value: '5', label: '5' },
    { value: '25', label: '25' },
    { value: '100', label: '100' }
  ]);

  let inviteLink = $derived(
    invite ? `${typeof window !== 'undefined' ? window.location.origin : ''}/invite/${invite.code}` : ''
  );

  async function generateInvite() {
    busy = true;
    try {
      invite = await chatApi.createInvite(guildId, {
        expiresInSeconds,
        maxUses
      });
      invites = await chatApi.listInvites(guildId);
    } catch (e) {
      toast.error(m.invite_dialog_create_error(), { description: (e as Error).message });
    } finally {
      busy = false;
    }
  }

  function onDialogClose() {
    onClose();
  }

  async function onExpireChange(val: string) {
    if (busy) return;
    expiresInSeconds = val ? Number(val) : undefined;
    await generateInvite();
  }

  async function onUsesChange(val: string) {
    if (busy) return;
    maxUses = val ? Number(val) : undefined;
    await generateInvite();
  }

  async function copyLink() {
    if (!inviteLink) return;
    await navigator.clipboard.writeText(inviteLink);
    toast.success(m.invite_dialog_copied());
  }

  async function revoke(code: string) {
    try {
      await chatApi.revokeInvite(code);
      invites = invites.filter((i) => i.code !== code);
      if (invite?.code === code) invite = null;
    } catch (e) {
      toast.error(m.invite_dialog_revoke_error(), { description: (e as Error).message });
    }
  }
</script>

<Dialog.Root {open} onOpenChange={(v) => { if (!v) onDialogClose(); }}>
  <Dialog.Content data-testid="invite-dialog" class="max-w-lg">
    <Dialog.Header>
      <Dialog.Title>{m.invite_dialog_title()}</Dialog.Title>
      <Dialog.Description>{m.invite_dialog_description()}</Dialog.Description>
    </Dialog.Header>

    <div class="space-y-4">
      <div class="flex gap-2">
        <Input
          readonly
          value={inviteLink}
          data-testid="invite-link-input"
          class="font-mono text-sm"
          placeholder={busy ? m.invite_dialog_link_creating() : ''}
        />
        <Button onclick={copyLink} disabled={!invite || busy} data-testid="invite-copy-btn">
          {m.invite_dialog_copy_btn()}
        </Button>
      </div>

      <div class="flex gap-4">
        <div class="flex-1 space-y-1">
          <p class="text-muted-foreground text-xs font-semibold uppercase tracking-wide">{m.invite_dialog_expires_after()}</p>
          <select
            class="border-input bg-background text-foreground w-full rounded-md border px-3 py-2 text-sm"
            onchange={(e) => onExpireChange((e.target as HTMLSelectElement).value)}
            data-testid="invite-expires-select"
          >
            {#each EXPIRE_OPTIONS as opt}
              <option value={opt.value}>{opt.label}</option>
            {/each}
          </select>
        </div>
        <div class="flex-1 space-y-1">
          <p class="text-muted-foreground text-xs font-semibold uppercase tracking-wide">{m.invite_dialog_max_uses()}</p>
          <select
            class="border-input bg-background text-foreground w-full rounded-md border px-3 py-2 text-sm"
            onchange={(e) => onUsesChange((e.target as HTMLSelectElement).value)}
            data-testid="invite-uses-select"
          >
            {#each USES_OPTIONS as opt}
              <option value={opt.value}>{opt.label}</option>
            {/each}
          </select>
        </div>
      </div>

      {#if invite}
        <InviteFriendPicker inviteCode={invite.code} disabled={busy} />
      {/if}

      {#if invites.length > 0}
        <div class="space-y-1">
          <p class="text-muted-foreground text-xs font-semibold uppercase tracking-wide">{m.invite_dialog_active_invites()}</p>
          <ul class="space-y-1" data-testid="invite-list">
            {#each invites as inv (inv.code)}
              <InviteListItem {inv} onRevoke={revoke} />
            {/each}
          </ul>
        </div>
      {/if}
    </div>

    <Dialog.Footer>
      <Button variant="ghost" onclick={onDialogClose}>{m.invite_dialog_close_btn()}</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
