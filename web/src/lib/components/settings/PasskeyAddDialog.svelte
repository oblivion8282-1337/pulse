<script lang="ts">
  /**
   * "Passkey hinzufügen" wizard. Two steps:
   *   1. name the passkey → `registerPasskey` runs the browser ceremony
   *      (Touch ID / security-key prompt happens inside that call)
   *   2. if this was the account's first MFA factor the server returns
   *      one-time backup codes — show them, gated behind an "I saved them"
   *      checkbox. Otherwise the dialog closes straight away.
   */
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import * as Alert from '$lib/components/ui/alert/index.js';
  import OctagonXIcon from '@lucide/svelte/icons/octagon-x';
  import { toast } from 'svelte-sonner';
  import { registerPasskey, type WebAuthnCredentialSummary } from '$lib/api/webauthn';
  import BackupCodesView from './BackupCodesView.svelte';
  import { m } from '$lib/paraglide/messages.js';
  import Checkbox from '$lib/components/form/Checkbox.svelte';

  type Props = {
    open?: boolean;
    onAdded: (cred: WebAuthnCredentialSummary) => void;
  };
  let { open = $bindable(false), onAdded }: Props = $props();

  type Step = 'name' | 'codes';
  let step = $state<Step>('name');
  let busy = $state(false);
  let error = $state<string | null>(null);
  let name = $state('');
  let backupCodes = $state<string[]>([]);
  let saved = $state(false);

  $effect(() => {
    if (!open) {
      step = 'name';
      busy = false;
      error = null;
      name = '';
      backupCodes = [];
      saved = false;
    }
  });

  async function create(e?: Event) {
    e?.preventDefault();
    if (busy) return;
    const trimmed = name.trim();
    if (!trimmed) {
      error = m.passkey_add_dialog_name_required();
      return;
    }
    busy = true;
    error = null;
    try {
      const res = await registerPasskey(trimmed);
      onAdded(res.credential);
      toast.success(m.passkey_add_dialog_added());
      if (res.backup_codes && res.backup_codes.length > 0) {
        backupCodes = res.backup_codes;
        step = 'codes';
      } else {
        open = false;
      }
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Portal>
    <Dialog.Overlay />
    <Dialog.Content data-testid="passkey-add-dialog" class="max-w-md">
      <Dialog.Header>
        <Dialog.Title>{m.passkey_add_dialog_title()}</Dialog.Title>
        <Dialog.Description>
          {#if step === 'name'}
            {m.passkey_add_dialog_description_name()}
          {:else}
            {m.passkey_add_dialog_description_codes()}
          {/if}
        </Dialog.Description>
      </Dialog.Header>

      {#if error}
        <Alert.Root variant="destructive" data-testid="passkey-add-error">
          <OctagonXIcon />
          <Alert.Description>{error}</Alert.Description>
        </Alert.Root>
      {/if}

      {#if step === 'name'}
        <form onsubmit={create} class="space-y-3">
          <div class="space-y-1.5">
            <Label for="passkey-name" class="text-text-muted text-xs font-semibold uppercase">
              Name
            </Label>
            <Input
              id="passkey-name"
              type="text"
              bind:value={name}
              placeholder={m.passkey_add_dialog_name_placeholder()}
              maxlength={64}
              autocomplete="off"
              data-testid="passkey-name-input"
            />
          </div>
          <Dialog.Footer>
            <Button
              variant="ghost"
              type="button"
              onclick={() => (open = false)}
              disabled={busy}
            >
              {m.passkey_add_dialog_cancel()}
            </Button>
            <Button type="submit" disabled={busy} data-testid="passkey-create">
              {busy ? m.passkey_add_dialog_creating() : m.passkey_add_dialog_create()}
            </Button>
          </Dialog.Footer>
        </form>
      {:else}
        <BackupCodesView codes={backupCodes} />
        <label class="text-text-base mt-3 flex items-center gap-2 text-sm">
          <Checkbox
            bind:checked={saved}
            data-testid="passkey-saved-check"
          />
          {m.passkey_add_dialog_saved_confirm()}
        </label>
        <Dialog.Footer>
          <Button onclick={() => (open = false)} disabled={!saved} data-testid="passkey-add-done">
            {m.passkey_add_dialog_done()}
          </Button>
        </Dialog.Footer>
      {/if}
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
