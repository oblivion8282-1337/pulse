<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import * as Alert from '$lib/components/ui/alert/index.js';
  import OctagonXIcon from '@lucide/svelte/icons/octagon-x';
  import { m } from '$lib/paraglide/messages.js';

  type Mode = 'choose' | 'create' | 'join';

  let {
    open = false,
    canCreate = true,
    initialMode = 'choose',
    onClose,
    onCreate,
    onJoin
  }: {
    open?: boolean;
    /** When false, only "Join via invite" is offered. Used for non-admins
     * on a self-hosted deploy where the admin hasn't opened up Server
     * creation. The "+"-Button stays visible so a fresh user can still
     * join a server via a friend's invite link. */
    canCreate?: boolean;
    /** Which screen to open on. The rail's "+" menu opens this dialog
     * directly in 'create' or 'join' so each menu item lands on its form;
     * 'choose' shows the picker. Only applied on the open-transition, so the
     * in-dialog "Zurück"-Button can still reach the chooser. */
    initialMode?: Mode;
    onClose: () => void;
    /** Create a new server with this name. May throw — the dialog shows the error. */
    onCreate: (name: string) => void | Promise<void>;
    /** Join via a pasted invite link or a bare code. May throw — the dialog shows the error. */
    onJoin: (linkOrCode: string) => void | Promise<void>;
  } = $props();

  let mode = $state<Mode>('choose');

  // Apply the requested start screen on the open-transition only (not on every
  // mode change — otherwise "Zurück" → 'choose' would snap straight back).
  // A non-admin without create rights is always forced into 'join'.
  let wasOpen = false;
  $effect(() => {
    if (open && !wasOpen) mode = !canCreate ? 'join' : initialMode;
    wasOpen = open;
  });
  let name = $state('');
  let inviteInput = $state('');
  let busy = $state(false);
  let error = $state<string | null>(null);

  function reset() {
    mode = 'choose';
    name = '';
    inviteInput = '';
    busy = false;
    error = null;
  }

  function handleOpenChange(next: boolean) {
    if (!next) {
      reset();
      onClose();
    }
  }

  function back() {
    mode = 'choose';
    error = null;
  }

  async function submitCreate(e: SubmitEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    busy = true;
    error = null;
    try {
      await onCreate(trimmed);
      // success → the parent navigates to the new guild and this dialog unmounts.
    } catch (err) {
      error = (err as Error)?.message || m.create_guild_dialog_create_failed();
      busy = false;
    }
  }

  async function submitJoin(e: SubmitEvent) {
    e.preventDefault();
    const trimmed = inviteInput.trim();
    if (!trimmed || busy) return;
    busy = true;
    error = null;
    try {
      await onJoin(trimmed);
    } catch (err) {
      error =
        (err as { status?: number })?.status === 404
          ? m.create_guild_dialog_invite_invalid()
          : (err as Error)?.message || m.create_guild_dialog_join_failed();
      busy = false;
    }
  }
</script>

<Dialog.Root {open} onOpenChange={handleOpenChange}>
  <Dialog.Content data-testid="create-guild-dialog">
    {#if mode === 'choose'}
      <Dialog.Header>
        <Dialog.Title>{m.create_guild_dialog_add_title()}</Dialog.Title>
        <Dialog.Description>
          {m.create_guild_dialog_add_description()}
        </Dialog.Description>
      </Dialog.Header>
      <div class="space-y-2">
        {#if canCreate}
          <button
            type="button"
            class="border-border hover:bg-bg-hover flex w-full items-center gap-3 rounded-xl border p-4 text-left transition-colors"
            onclick={() => (mode = 'create')}
            data-testid="create-guild-choice"
          >
            <div>
              <div class="text-text-bright font-semibold">{m.create_guild_dialog_create_own_title()}</div>
              <div class="text-text-muted text-xs">{m.create_guild_dialog_create_own_hint()}</div>
            </div>
          </button>
        {/if}
        <button
          type="button"
          class="border-border hover:bg-bg-hover flex w-full items-center gap-3 rounded-xl border p-4 text-left transition-colors"
          onclick={() => (mode = 'join')}
          data-testid="join-guild-choice"
        >
          <div>
            <div class="text-text-bright font-semibold">{m.create_guild_dialog_join_title()}</div>
            <div class="text-text-muted text-xs">{m.create_guild_dialog_join_hint()}</div>
          </div>
        </button>
      </div>
    {:else if mode === 'create'}
      <Dialog.Header>
        <Dialog.Title>{m.create_guild_dialog_create_title()}</Dialog.Title>
        <Dialog.Description>{m.create_guild_dialog_create_description()}</Dialog.Description>
      </Dialog.Header>
      <form class="space-y-4" onsubmit={submitCreate}>
        <div class="space-y-1.5">
          <Label
            for="create-guild-name"
            class="text-muted-foreground text-xs font-semibold uppercase tracking-wide"
          >
            {m.create_guild_dialog_name_label()}
          </Label>
          <Input
            id="create-guild-name"
            type="text"
            bind:value={name}
            required
            minlength={1}
            maxlength={64}
            data-testid="create-guild-name"
          />
        </div>
        {#if error}
          <Alert.Root variant="destructive">
            <OctagonXIcon />
            <Alert.Description>{error}</Alert.Description>
          </Alert.Root>
        {/if}
        <Dialog.Footer>
          <Button type="button" variant="ghost" onclick={back} disabled={busy}>{m.create_guild_dialog_back()}</Button>
          <Button type="submit" disabled={busy} data-testid="create-guild-submit">
            {busy ? m.create_guild_dialog_creating() : m.create_guild_dialog_create_submit()}
          </Button>
        </Dialog.Footer>
      </form>
    {:else}
      <Dialog.Header>
        <Dialog.Title>{m.create_guild_dialog_join_modal_title()}</Dialog.Title>
        <Dialog.Description>{m.create_guild_dialog_join_description()}</Dialog.Description>
      </Dialog.Header>
      <form class="space-y-4" onsubmit={submitJoin}>
        <div class="space-y-1.5">
          <Label
            for="join-guild-input"
            class="text-muted-foreground text-xs font-semibold uppercase tracking-wide"
          >
            {m.create_guild_dialog_invite_label()}
          </Label>
          <Input
            id="join-guild-input"
            type="text"
            bind:value={inviteInput}
            required
            autocomplete="off"
            placeholder={m.create_guild_dialog_invite_placeholder()}
            data-testid="join-guild-input"
          />
        </div>
        {#if error}
          <Alert.Root variant="destructive" data-testid="join-guild-error">
            <OctagonXIcon />
            <Alert.Description>{error}</Alert.Description>
          </Alert.Root>
        {/if}
        <Dialog.Footer>
          <Button type="button" variant="ghost" onclick={back} disabled={busy}>{m.create_guild_dialog_back()}</Button>
          <Button type="submit" disabled={busy} data-testid="join-guild-submit">
            {busy ? m.create_guild_dialog_joining() : m.create_guild_dialog_join_submit()}
          </Button>
        </Dialog.Footer>
      </form>
    {/if}
  </Dialog.Content>
</Dialog.Root>
