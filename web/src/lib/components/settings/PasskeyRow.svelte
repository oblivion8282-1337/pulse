<script lang="ts">
  /**
   * One registered passkey in the settings list: name + last-used meta, with
   * inline rename and a two-tap delete confirm (no separate dialog — a passkey
   * is cheap to re-enrol, and removing one isn't account-destructive).
   */
  import { toast } from 'svelte-sonner';
  import FingerprintIcon from '@lucide/svelte/icons/fingerprint';
  import PencilIcon from '@lucide/svelte/icons/pencil';
  import Trash2Icon from '@lucide/svelte/icons/trash-2';
  import CheckIcon from '@lucide/svelte/icons/check';
  import XIcon from '@lucide/svelte/icons/x';
  import { Input } from '$lib/components/ui/input/index.js';
  import { renamePasskey, deletePasskey, type WebAuthnCredentialSummary } from '$lib/api/webauthn';

  type Props = {
    passkey: WebAuthnCredentialSummary;
    onRenamed: (cred: WebAuthnCredentialSummary) => void;
    onRemoved: (id: string) => void;
  };
  let { passkey, onRenamed, onRemoved }: Props = $props();

  let editing = $state(false);
  let confirmDelete = $state(false);
  let busy = $state(false);
  // Filled by `startEdit` — editing is only ever entered through it, so the
  // empty initial value is never shown.
  let nameDraft = $state('');

  function fmtDate(iso: string | null): string {
    if (!iso) return 'noch nicht benutzt';
    return new Date(iso).toLocaleDateString('de-DE', {
      day: '2-digit',
      month: 'short',
      year: 'numeric'
    });
  }

  function startEdit() {
    nameDraft = passkey.name;
    editing = true;
  }

  async function saveRename() {
    const name = nameDraft.trim();
    if (!name || name === passkey.name) {
      editing = false;
      return;
    }
    busy = true;
    try {
      onRenamed(await renamePasskey(passkey.id, name));
      editing = false;
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      busy = false;
    }
  }

  async function remove() {
    busy = true;
    try {
      await deletePasskey(passkey.id);
      onRemoved(passkey.id);
      toast.success('Passkey entfernt');
    } catch (err) {
      toast.error((err as Error).message);
      busy = false;
      confirmDelete = false;
    }
  }
</script>

<li
  class="border-border bg-bg-input/40 flex items-center gap-3 rounded-xl border p-3"
  data-testid="passkey-row"
>
  <span class="bg-bg-input text-text-muted flex size-9 shrink-0 items-center justify-center rounded-full">
    <FingerprintIcon class="size-4" />
  </span>

  <div class="flex min-w-0 flex-1 flex-col gap-0.5">
    {#if editing}
      <Input
        bind:value={nameDraft}
        maxlength={64}
        class="h-7 text-sm"
        data-testid="passkey-rename-input"
        onkeydown={(e: KeyboardEvent) => {
          if (e.key === 'Enter') saveRename();
          if (e.key === 'Escape') (editing = false);
        }}
      />
    {:else}
      <span class="text-text-bright truncate text-sm font-medium">{passkey.name}</span>
    {/if}
    <span class="text-text-muted text-xs">
      Hinzugefügt {fmtDate(passkey.created_at)} · Zuletzt benutzt {fmtDate(passkey.last_used_at)}
    </span>
  </div>

  <div class="flex shrink-0 items-center gap-1">
    {#if editing}
      <button
        type="button"
        onclick={saveRename}
        disabled={busy}
        class="text-emerald-500 hover:bg-bg-hover rounded-md p-1.5 transition-colors"
        aria-label="Namen speichern"
        data-testid="passkey-rename-save"
      >
        <CheckIcon class="size-4" />
      </button>
      <button
        type="button"
        onclick={() => (editing = false)}
        disabled={busy}
        class="text-text-muted hover:bg-bg-hover rounded-md p-1.5 transition-colors"
        aria-label="Abbrechen"
      >
        <XIcon class="size-4" />
      </button>
    {:else if confirmDelete}
      <button
        type="button"
        onclick={remove}
        disabled={busy}
        class="text-destructive bg-destructive/10 hover:bg-destructive/20 rounded-md px-2 py-1 text-xs font-medium transition-colors"
        data-testid="passkey-delete-confirm"
      >
        {busy ? 'Entferne…' : 'Wirklich entfernen'}
      </button>
      <button
        type="button"
        onclick={() => (confirmDelete = false)}
        disabled={busy}
        class="text-text-muted hover:bg-bg-hover rounded-md p-1.5 transition-colors"
        aria-label="Abbrechen"
      >
        <XIcon class="size-4" />
      </button>
    {:else}
      <button
        type="button"
        onclick={startEdit}
        class="text-text-muted hover:bg-bg-hover rounded-md p-1.5 transition-colors"
        aria-label="Passkey umbenennen"
        data-testid="passkey-rename"
      >
        <PencilIcon class="size-4" />
      </button>
      <button
        type="button"
        onclick={() => (confirmDelete = true)}
        class="text-text-muted hover:text-destructive hover:bg-bg-hover rounded-md p-1.5 transition-colors"
        aria-label="Passkey entfernen"
        data-testid="passkey-delete"
      >
        <Trash2Icon class="size-4" />
      </button>
    {/if}
  </div>
</li>
