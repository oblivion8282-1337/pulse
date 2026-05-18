<script lang="ts">
  /**
   * Disable-2FA dialog. The server requires password + exactly one of (code |
   * backup_code). We let the user toggle which form of the second factor they
   * provide. On success the parent updates the auth-store; we just close.
   */
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import * as Alert from '$lib/components/ui/alert/index.js';
  import OctagonXIcon from '@lucide/svelte/icons/octagon-x';
  import { totpDisable } from '$lib/api/auth';
  import { auth } from '$lib/stores/auth.svelte';
  import { stripTotpFormatting, normalizeBackupCode } from '$lib/auth/format';

  let { open = $bindable(false) }: { open?: boolean } = $props();

  let password = $state('');
  let code = $state('');
  let backupCode = $state('');
  let useBackup = $state(false);
  let busy = $state(false);
  let error = $state<string | null>(null);

  $effect(() => {
    if (!open) {
      password = '';
      code = '';
      backupCode = '';
      useBackup = false;
      busy = false;
      error = null;
    }
  });

  async function submit(e: Event) {
    e.preventDefault();
    if (busy) return;
    if (!password) {
      error = 'Bitte Passwort eingeben.';
      return;
    }
    error = null;
    busy = true;
    try {
      if (useBackup) {
        const normalized = normalizeBackupCode(backupCode);
        if (!normalized) {
          error = 'Backup-Code darf nicht leer sein.';
          return;
        }
        await totpDisable(password, { backup_code: normalized });
      } else {
        const digits = stripTotpFormatting(code);
        if (digits.length !== 6) {
          error = 'Bitte 6-stelligen Code eingeben.';
          return;
        }
        await totpDisable(password, { code: digits });
      }
      if (auth.user) auth.setUser({ ...auth.user, totp_enabled: false });
      open = false;
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
    <Dialog.Content data-testid="totp-disable-dialog" class="max-w-md">
      <Dialog.Header>
        <Dialog.Title>2FA deaktivieren</Dialog.Title>
        <Dialog.Description>
          Du musst beim nächsten Login keine 2FA mehr eingeben — dein Account ist dann weniger
          geschützt.
        </Dialog.Description>
      </Dialog.Header>

      <form onsubmit={submit} class="space-y-3">
        <div class="space-y-1.5">
          <Label for="totp-disable-password" class="text-text-muted text-xs font-semibold uppercase">
            Passwort
          </Label>
          <Input
            id="totp-disable-password"
            type="password"
            autocomplete="current-password"
            bind:value={password}
            required
            data-testid="totp-disable-password"
          />
        </div>

        {#if useBackup}
          <div class="space-y-1.5">
            <Label
              for="totp-disable-backup"
              class="text-text-muted text-xs font-semibold uppercase"
            >
              Backup-Code
            </Label>
            <Input
              id="totp-disable-backup"
              type="text"
              autocapitalize="characters"
              spellcheck={false}
              bind:value={backupCode}
              required
              data-testid="totp-disable-backup"
            />
          </div>
        {:else}
          <div class="space-y-1.5">
            <Label for="totp-disable-code" class="text-text-muted text-xs font-semibold uppercase">
              Aktueller Code aus der App
            </Label>
            <Input
              id="totp-disable-code"
              type="text"
              inputmode="numeric"
              autocomplete="one-time-code"
              bind:value={code}
              required
              maxlength={7}
              class="text-center font-mono tracking-[0.2em]"
              data-testid="totp-disable-code"
            />
          </div>
        {/if}

        <button
          type="button"
          class="text-primary text-xs hover:underline"
          onclick={() => {
            useBackup = !useBackup;
            error = null;
          }}
          data-testid="totp-disable-toggle"
        >
          {useBackup ? '6-stelligen Code verwenden' : 'Backup-Code verwenden'}
        </button>

        {#if error}
          <Alert.Root variant="destructive" data-testid="totp-disable-error">
            <OctagonXIcon />
            <Alert.Description>{error}</Alert.Description>
          </Alert.Root>
        {/if}

        <Dialog.Footer>
          <Button variant="secondary" type="button" onclick={() => (open = false)} disabled={busy}>
            Abbrechen
          </Button>
          <Button type="submit" disabled={busy} data-testid="totp-disable-submit">
            {busy ? 'Deaktivieren…' : '2FA deaktivieren'}
          </Button>
        </Dialog.Footer>
      </form>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
