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
  import { Label } from '$lib/components/ui/label/index.js';
  import * as Alert from '$lib/components/ui/alert/index.js';
  import OctagonXIcon from '@lucide/svelte/icons/octagon-x';
  import { totpBackupRegenerate } from '$lib/api/auth';
  import { stripTotpFormatting } from '$lib/auth/format';
  import BackupCodesView from './BackupCodesView.svelte';

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
      error = 'Bitte Passwort eingeben.';
      return;
    }
    if (digits.length !== 6) {
      error = 'Bitte 6-stelligen Code eingeben.';
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
        <Dialog.Title>Backup-Codes neu generieren</Dialog.Title>
        <Dialog.Description>
          {#if phase === 'auth'}
            Bestätige dein Passwort und einen aktuellen Code aus der App. Der alte Satz wird damit
            ungültig.
          {:else}
            Speichere die neuen Codes — der alte Satz funktioniert ab jetzt nicht mehr.
          {/if}
        </Dialog.Description>
      </Dialog.Header>

      {#if phase === 'auth'}
        <form onsubmit={submit} class="space-y-3">
          <div class="space-y-1.5">
            <Label for="totp-regen-password" class="text-text-muted text-xs font-semibold uppercase">
              Passwort
            </Label>
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
            <Label for="totp-regen-code" class="text-text-muted text-xs font-semibold uppercase">
              Aktueller Code
            </Label>
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
            <Button variant="secondary" type="button" onclick={() => (open = false)} disabled={busy}>
              Abbrechen
            </Button>
            <Button type="submit" disabled={busy} data-testid="totp-regen-submit">
              {busy ? 'Generieren…' : 'Neue Codes erzeugen'}
            </Button>
          </Dialog.Footer>
        </form>
      {:else}
        <BackupCodesView {codes} />
        <label class="text-text-base mt-3 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            class="size-5 accent-[var(--brand)] md:size-4"
            bind:checked={saved}
            data-testid="totp-regen-saved-check"
          />
          Ich habe die neuen Codes gespeichert.
        </label>
        <Dialog.Footer>
          <Button onclick={() => (open = false)} disabled={!saved} data-testid="totp-regen-done">
            Fertig
          </Button>
        </Dialog.Footer>
      {/if}
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
