<script lang="ts">
  /**
   * Two-phase dialog:
   *   - phase 'auth'   → ask for password + current TOTP code → POST regenerate
   *   - phase 'codes'  → render new backup codes, gate close behind "I saved"
   *
   * Mirrors the second half of TotpEnableDialog visually.
   */
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import FieldLabel from '$lib/components/form/FieldLabel.svelte';
  import * as Alert from '$lib/components/ui/alert/index.js';
  import OctagonXIcon from '@lucide/svelte/icons/octagon-x';
  import { totpBackupRegenerate } from '$lib/api/auth';
  import { stripTotpFormatting } from '$lib/auth/format';
  import BackupCodesView from './BackupCodesView.svelte';
  import { m } from '$lib/paraglide/messages.js';
  import Checkbox from '$lib/components/form/Checkbox.svelte';

  let { open = $bindable(false) }: { open?: boolean } = $props();

  type Phase = 'auth' | 'codes';
  let phase = $state<Phase>('auth');
  let password = $state('');
  let code = $state('');
  let busy = $state(false);
  let error = $state<string | null>(null);
  let codes = $state<string[]>([]);
  let saved = $state(false);

  $effect(() => {
    if (!open) {
      phase = 'auth';
      password = '';
      code = '';
      busy = false;
      error = null;
      codes = [];
      saved = false;
    }
  });

  async function submit(e: Event) {
    e.preventDefault();
    if (busy) return;
    const digits = stripTotpFormatting(code);
    if (!password) {
      error = m.totp_backup_regen_error_no_password();
      return;
    }
    if (digits.length !== 6) {
      error = m.totp_backup_regen_error_invalid_code();
      return;
    }
    error = null;
    busy = true;
    try {
      const res = await totpBackupRegenerate(password, digits);
      codes = res.backup_codes;
      phase = 'codes';
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
    <Dialog.Content data-testid="totp-backup-regen-dialog" class="max-w-md">
      <Dialog.Header>
        <Dialog.Title>{m.totp_backup_regen_title()}</Dialog.Title>
        <Dialog.Description>
          {#if phase === 'auth'}
            {m.totp_backup_regen_desc_auth()}
          {:else}
            {m.totp_backup_regen_desc_codes()}
          {/if}
        </Dialog.Description>
      </Dialog.Header>

      {#if phase === 'auth'}
        <form onsubmit={submit} class="space-y-3">
          <div class="space-y-1.5">
            <FieldLabel for="totp-regen-password" required class="text-text-muted text-xs font-semibold uppercase">
              {m.totp_backup_regen_label_password()}
            </FieldLabel>
            <Input
              id="totp-regen-password"
              type="password"
              autocomplete="current-password"
              bind:value={password}
              required
              data-testid="totp-regen-password"
            />
          </div>
          <div class="space-y-1.5">
            <FieldLabel for="totp-regen-code" required class="text-text-muted text-xs font-semibold uppercase">
              {m.totp_backup_regen_label_current_code()}
            </FieldLabel>
            <Input
              id="totp-regen-code"
              type="text"
              inputmode="numeric"
              autocomplete="one-time-code"
              bind:value={code}
              required
              maxlength={7}
              class="text-center font-mono tracking-[0.2em]"
              data-testid="totp-regen-code"
            />
          </div>

          {#if error}
            <Alert.Root variant="destructive" data-testid="totp-regen-error">
              <OctagonXIcon />
              <Alert.Description>{error}</Alert.Description>
            </Alert.Root>
          {/if}

          <Dialog.Footer>
            <Button variant="ghost" type="button" onclick={() => (open = false)} disabled={busy}>
              {m.totp_backup_regen_cancel()}
            </Button>
            <Button type="submit" disabled={busy} data-testid="totp-regen-submit">
              {busy ? m.totp_backup_regen_generating() : m.totp_backup_regen_submit()}
            </Button>
          </Dialog.Footer>
        </form>
      {:else}
        <BackupCodesView {codes} />
        <label class="text-text-base mt-3 flex items-center gap-2 text-sm">
          <Checkbox
            bind:checked={saved}
            data-testid="totp-regen-saved-check"
          />
          {m.totp_backup_regen_saved_confirm()}
        </label>
        <Dialog.Footer>
          <Button onclick={() => (open = false)} disabled={!saved} data-testid="totp-regen-done">
            {m.totp_backup_regen_done()}
          </Button>
        </Dialog.Footer>
      {/if}
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
