<script lang="ts">
  /**
   * Per-guild nickname editor. Targets the caller (CHANGE_NICKNAME) or
   * another member (MANAGE_NICKNAMES) — the parent decides which mode
   * via the ``isSelf`` flag; this component just submits the right
   * route.
   *
   * Empty string clears the nickname (server normalises trim → null).
   */
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import { chatApi } from '$lib/api/chat';
  import { toast } from 'svelte-sonner';

  let {
    open = false,
    guildId,
    userId,
    isSelf,
    initialNickname,
    fallbackName,
    onClose,
    onSaved
  }: {
    open?: boolean;
    guildId: string;
    userId: string;
    isSelf: boolean;
    /** Current per-guild nickname; ``undefined`` means "not provided —
     *  fetch on open". Pass ``null`` if you know the value and it's
     *  empty (skips the fetch). */
    initialNickname: string | null | undefined;
    fallbackName: string;
    onClose: () => void;
    onSaved?: (nickname: string | null) => void;
  } = $props();

  let value = $state('');
  let busy = $state(false);
  // Local tracker for the "current" nickname — the prop may be undefined
  // (caller didn't know), in which case we resolve it via a member-list
  // lookup the first time the dialog opens.
  let resolved = $state<string | null>(null);

  $effect(() => {
    if (!open) return;
    if (initialNickname !== undefined) {
      resolved = initialNickname;
      value = initialNickname ?? '';
      return;
    }
    // Lookup-on-open path: fetch the member row so we can pre-fill the
    // input AND offer the "Zurücksetzen" button. listMembers is the
    // existing endpoint; for very large guilds we'd want a per-member
    // GET but for v1 the round-trip is acceptable.
    void chatApi
      .listMembers(guildId)
      .then((rows) => {
        const me = rows.find((m) => m.user_id === userId);
        resolved = me?.nickname ?? null;
        value = resolved ?? '';
      })
      .catch(() => {
        resolved = null;
        value = '';
      });
  });

  function handleOpenChange(next: boolean) {
    if (!next) {
      value = '';
      busy = false;
      onClose();
    }
  }

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    const next = value.trim();
    if (next === (resolved ?? '')) {
      onClose();
      return;
    }
    busy = true;
    try {
      const updated = isSelf
        ? await chatApi.setSelfNickname(guildId, next)
        : await chatApi.setMemberNickname(guildId, userId, next);
      onSaved?.(updated.nickname ?? null);
      onClose();
    } catch (err) {
      toast.error('Nickname konnte nicht gespeichert werden', {
        description: (err as Error).message
      });
    } finally {
      busy = false;
    }
  }

  async function reset() {
    if (busy) return;
    busy = true;
    try {
      const updated = isSelf
        ? await chatApi.setSelfNickname(guildId, '')
        : await chatApi.setMemberNickname(guildId, userId, '');
      onSaved?.(updated.nickname ?? null);
      onClose();
    } catch (err) {
      toast.error('Nickname konnte nicht zurückgesetzt werden', {
        description: (err as Error).message
      });
    } finally {
      busy = false;
    }
  }
</script>

<Dialog.Root {open} onOpenChange={handleOpenChange}>
  <Dialog.Content data-testid="nickname-dialog">
    <Dialog.Header>
      <Dialog.Title>
        {isSelf ? 'Eigenen Nickname ändern' : `Nickname für ${fallbackName}`}
      </Dialog.Title>
      <Dialog.Description>
        Gilt nur in dieser Community. Leer lassen, um den Standardnamen zu nutzen.
      </Dialog.Description>
    </Dialog.Header>
    <form class="space-y-4" onsubmit={submit}>
      <div class="space-y-1.5">
        <Label for="nickname-input" class="text-muted-foreground text-xs font-semibold uppercase tracking-wide">
          Nickname
        </Label>
        <Input
          id="nickname-input"
          type="text"
          bind:value
          maxlength={64}
          placeholder={fallbackName}
          disabled={busy}
          data-testid="nickname-input"
        />
      </div>
      <Dialog.Footer>
        {#if resolved}
          <Button
            type="button"
            variant="ghost"
            onclick={reset}
            disabled={busy}
            data-testid="nickname-reset"
          >
            Zurücksetzen
          </Button>
        {/if}
        <Button type="button" variant="ghost" onclick={() => handleOpenChange(false)} disabled={busy}>
          Abbrechen
        </Button>
        <Button type="submit" disabled={busy} data-testid="nickname-submit">
          {busy ? 'Speichern…' : 'Speichern'}
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
