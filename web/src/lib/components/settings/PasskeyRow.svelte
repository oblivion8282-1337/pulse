<script lang="ts">
  /**
   * One registered passkey in the settings list: name + last-used meta, with
   * inline rename and a two-tap delete confirm (no separate dialog — a passkey
   * is cheap to re-enrol, and removing one isn't account-destructive).
   */
  import { toast } from 'svelte-sonner';
  import { Button } from '$lib/components/ui/button/index.js';
  import FingerprintIcon from '@lucide/svelte/icons/fingerprint';
  import PencilIcon from '@lucide/svelte/icons/pencil';
  import Trash2Icon from '@lucide/svelte/icons/trash-2';
  import CheckIcon from '@lucide/svelte/icons/check';
  import XIcon from '@lucide/svelte/icons/x';
  import { Input } from '$lib/components/ui/input/index.js';
  import { renamePasskey, deletePasskey, type WebAuthnCredentialSummary } from '$lib/api/webauthn';
  import { formatLangDatum } from '$lib/utils/formatLangDatum';
  import { m } from '$lib/paraglide/messages.js';

  type Props = {
    passkey: WebAuthnCredentialSummary;
    onRenamed: (cred: WebAuthnCredentialSummary) => void;
    onRemoved: (id: string) => void;
  };
  let { passkey, onRenamed, onRemoved }: Props = $props();

  let editing = $state(false);
  let confirmDelete = $state(false);
  let loeschPasswort = $state('');
  let busy = $state(false);
  // Filled by `startEdit` — editing is only ever entered through it, so the
  // empty initial value is never shown.
  let nameDraft = $state('');

  function fmtDate(iso: string | null): string {
    if (!iso) return m.passkey_row_never_used();
    return formatLangDatum(iso, 'short');
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
    // Seit 2026-08-13 verlangt der Server das Passwort: das Löschen des LETZTEN
    // Schlüssels nimmt dem Konto seinen zweiten Faktor mit — es war damit der
    // stillste Weg, ein fremdes Konto zu entschärfen.
    if (!loeschPasswort) {
      toast.error(m.passkey_row_password_required());
      return;
    }
    busy = true;
    try {
      await deletePasskey(passkey.id, loeschPasswort);
      onRemoved(passkey.id);
      toast.success(m.passkey_row_removed());
    } catch (err) {
      toast.error((err as Error).message);
      busy = false;
      // Den Bestätigungs-Zustand STEHEN lassen: ein Tippfehler im Passwort soll
      // nicht bedeuten, dass man von vorn anfängt.
      loeschPasswort = '';
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
        class="h-9 text-sm md:h-7"
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
      {m.passkey_row_meta({ added: fmtDate(passkey.created_at), lastUsed: fmtDate(passkey.last_used_at) })}
    </span>
  </div>

  <div class="flex shrink-0 items-center gap-1">
    {#if editing}
      <Button
        variant="ghost"
        size="icon-sm"
        onclick={saveRename}
        disabled={busy}
        class="text-success"
        aria-label={m.passkey_row_save_name()}
        data-testid="passkey-rename-save"
      >
        <CheckIcon class="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onclick={() => (editing = false)}
        disabled={busy}
        aria-label={m.passkey_row_cancel()}
      >
        <XIcon class="size-4" />
      </Button>
    {:else if confirmDelete}
      <Input
        type="password"
        autocomplete="current-password"
        bind:value={loeschPasswort}
        placeholder={m.passkey_row_password_label()}
        class="h-7 w-40 text-xs"
        data-testid="passkey-delete-password"
      />
      <Button
        variant="destructive"
        size="xs"
        onclick={remove}
        disabled={busy}
        data-testid="passkey-delete-confirm"
      >
        {busy ? m.passkey_row_removing() : m.passkey_row_confirm_remove()}
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onclick={() => {
          confirmDelete = false;
          loeschPasswort = '';
        }}
        disabled={busy}
        aria-label={m.passkey_row_cancel()}
      >
        <XIcon class="size-4" />
      </Button>
    {:else}
      <Button
        variant="ghost"
        size="icon-sm"
        onclick={startEdit}
        aria-label={m.passkey_row_rename()}
        data-testid="passkey-rename"
      >
        <PencilIcon class="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onclick={() => (confirmDelete = true)}
        class="hover:text-destructive"
        aria-label={m.passkey_row_delete()}
        data-testid="passkey-delete"
      >
        <Trash2Icon class="size-4" />
      </Button>
    {/if}
  </div>
</li>
