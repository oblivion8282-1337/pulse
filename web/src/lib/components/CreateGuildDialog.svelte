<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import * as Alert from '$lib/components/ui/alert/index.js';
  import OctagonXIcon from '@lucide/svelte/icons/octagon-x';

  let {
    open = false,
    canCreate = true,
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
    onClose: () => void;
    /** Create a new server with this name. May throw — the dialog shows the error. */
    onCreate: (name: string) => void | Promise<void>;
    /** Join via a pasted invite link or a bare code. May throw — the dialog shows the error. */
    onJoin: (linkOrCode: string) => void | Promise<void>;
  } = $props();

  type Mode = 'choose' | 'create' | 'join';
  let mode = $state<Mode>('choose');

  // Skip the chooser when only one option exists — open the dialog
  // straight into the join form to save a click for non-admins.
  $effect(() => {
    if (open && !canCreate && mode === 'choose') mode = 'join';
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
      error = (err as Error)?.message || 'Server erstellen fehlgeschlagen.';
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
          ? 'Diese Einladung ist ungültig oder abgelaufen.'
          : (err as Error)?.message || 'Beitreten fehlgeschlagen.';
      busy = false;
    }
  }
</script>

<Dialog.Root {open} onOpenChange={handleOpenChange}>
  <Dialog.Content data-testid="create-guild-dialog">
    {#if mode === 'choose'}
      <Dialog.Header>
        <Dialog.Title>Gilde hinzufügen</Dialog.Title>
        <Dialog.Description>
          Erstelle eine eigene Gilde oder tritt einer über eine Einladung bei.
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
              <div class="text-text-bright font-semibold">Eigene Gilde erstellen</div>
              <div class="text-text-muted text-xs">Du wirst der Owner.</div>
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
            <div class="text-text-bright font-semibold">Einer Gilde beitreten</div>
            <div class="text-text-muted text-xs">Mit einem Einladungslink oder -code.</div>
          </div>
        </button>
      </div>
    {:else if mode === 'create'}
      <Dialog.Header>
        <Dialog.Title>Gilde erstellen</Dialog.Title>
        <Dialog.Description>Gib deiner Gilde einen Namen.</Dialog.Description>
      </Dialog.Header>
      <form class="space-y-4" onsubmit={submitCreate}>
        <div class="space-y-1.5">
          <Label
            for="create-guild-name"
            class="text-muted-foreground text-xs font-semibold uppercase tracking-wide"
          >
            Server-Name
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
          <Button type="button" variant="ghost" onclick={back} disabled={busy}>Zurück</Button>
          <Button type="submit" disabled={busy} data-testid="create-guild-submit">
            {busy ? 'Erstellen…' : 'Erstellen'}
          </Button>
        </Dialog.Footer>
      </form>
    {:else}
      <Dialog.Header>
        <Dialog.Title>Server beitreten</Dialog.Title>
        <Dialog.Description>Füge den Einladungslink oder den Code ein.</Dialog.Description>
      </Dialog.Header>
      <form class="space-y-4" onsubmit={submitJoin}>
        <div class="space-y-1.5">
          <Label
            for="join-guild-input"
            class="text-muted-foreground text-xs font-semibold uppercase tracking-wide"
          >
            Einladungslink oder -code
          </Label>
          <Input
            id="join-guild-input"
            type="text"
            bind:value={inviteInput}
            required
            autocomplete="off"
            placeholder="https://pulse.unicutmedia.com/invite/… oder abcd1234"
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
          <Button type="button" variant="ghost" onclick={back} disabled={busy}>Zurück</Button>
          <Button type="submit" disabled={busy} data-testid="join-guild-submit">
            {busy ? 'Beitreten…' : 'Beitreten'}
          </Button>
        </Dialog.Footer>
      </form>
    {/if}
  </Dialog.Content>
</Dialog.Root>
