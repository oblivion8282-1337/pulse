<script lang="ts">
  /**
   * Zwei-Stufen-Dialog für die Account-Löschung.
   *
   * Step 1 ("warn"): Konsequenzen-Bullet-Liste + Username-Confirm-Input.
   *   Weiter ist disabled bis der getippte Username exakt dem eigenen
   *   matched (trim-only; case-sensitiv, weil Snowflake-IDs aufm Backend
   *   eindeutig per case-sensitive Match laufen).
   * Step 2 ("credentials"): Password + (wenn `totp_enabled`) Code oder
   *   Backup-Code → in `DeleteAccountCredentialsStep.svelte` ausgelagert
   *   (Größen-Policy). Submit → DELETE /api/auth/me; bei 204 lokal
   *   abmelden + zur Login-Seite.
   *
   * Fehlerklassen werden vom Server via `detail` durchgereicht — wir mappen
   * `ApiError.status` auf je eine Toast-Variante. Die Inputs werden auf 401
   * geleert (statt nochmal weggeworfen), damit der User direkt
   * weitertippen kann.
   *
   * Reset-Strategie: alles über $effect(open) → bei jedem Schließen
   * frisch. Closing während des Submits ist durch `busy`-Gating verhindert
   * (Buttons disabled, AlertDialog hat keine echten Close-Hooks die das
   * umgehen würden).
   */
  import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
  import { toast } from 'svelte-sonner';
  import { deleteAccount } from '$lib/api/auth';
  import { ApiError } from '$lib/api/client';
  import { auth } from '$lib/stores/auth.svelte';
  import { stripTotpFormatting, normalizeBackupCode } from '$lib/auth/format';
  import DeleteAccountCredentialsStep from './DeleteAccountCredentialsStep.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let { open = $bindable(false) }: { open?: boolean } = $props();

  let step = $state<'warn' | 'credentials'>('warn');
  let confirmUsername = $state('');
  let password = $state('');
  let code = $state('');
  let backupCode = $state('');
  let useBackup = $state(false);
  let busy = $state(false);
  let error = $state<string | null>(null);

  const username = $derived(auth.user?.username ?? '');
  const totpEnabled = $derived(auth.user?.totp_enabled === true);
  const usernameMatches = $derived(confirmUsername.trim() === username && username !== '');

  $effect(() => {
    if (!open) {
      step = 'warn';
      confirmUsername = '';
      password = '';
      code = '';
      backupCode = '';
      useBackup = false;
      busy = false;
      error = null;
    }
  });

  function goNext() {
    if (!usernameMatches) return;
    error = null;
    step = 'credentials';
  }

  function goBack() {
    if (busy) return;
    error = null;
    password = '';
    code = '';
    backupCode = '';
    step = 'warn';
  }

  async function submit(e: Event) {
    e.preventDefault();
    if (busy) return;
    if (!password) {
      error = m.delete_account_dialog_error_password_required();
      return;
    }
    const input: {
      password: string;
      confirm_username: string;
      code?: string;
      backup_code?: string;
    } = { password, confirm_username: username };
    if (totpEnabled) {
      if (useBackup) {
        const normalized = normalizeBackupCode(backupCode);
        if (!normalized) {
          error = m.delete_account_dialog_error_backup_code_empty();
          return;
        }
        input.backup_code = normalized;
      } else {
        const digits = stripTotpFormatting(code);
        if (digits.length !== 6) {
          error = m.delete_account_dialog_error_totp_six_digits();
          return;
        }
        input.code = digits;
      }
    }
    error = null;
    busy = true;
    try {
      await deleteAccount(input);
      toast.success(m.delete_account_dialog_toast_deleted());
      open = false;
      auth.signOut();
    } catch (err) {
      handleError(err);
    } finally {
      busy = false;
    }
  }

  function handleError(err: unknown) {
    if (err instanceof ApiError) {
      if (err.status === 400) {
        toast.error(m.delete_account_dialog_toast_username_mismatch());
        password = '';
        code = '';
        backupCode = '';
        step = 'warn';
        return;
      }
      if (err.status === 401) {
        toast.error(m.delete_account_dialog_toast_wrong_credentials());
        password = '';
        code = '';
        backupCode = '';
        return;
      }
      if (err.status === 429) {
        toast.error(m.delete_account_dialog_toast_too_many_attempts());
        return;
      }
      if (err.status === 503) {
        toast.error(m.delete_account_dialog_toast_deletion_unavailable(), {
          description: m.delete_account_dialog_toast_deletion_unavailable_desc()
        });
        return;
      }
    }
    error = (err as Error).message ?? m.delete_account_dialog_error_unknown();
  }
</script>

<AlertDialog.Root bind:open>
  <AlertDialog.Content data-testid="delete-account-dialog">
    {#if step === 'warn'}
      <AlertDialog.Header>
        <AlertDialog.Title>
          <span class="text-destructive flex items-center gap-2">
            <TriangleAlertIcon class="size-5" />
            {m.delete_account_dialog_title()}
          </span>
        </AlertDialog.Title>
        <AlertDialog.Description>
          {m.delete_account_dialog_description_before_bold()}<strong>{m.delete_account_dialog_description_bold()}</strong>{m.delete_account_dialog_description_after_bold()}
        </AlertDialog.Description>
      </AlertDialog.Header>

      <ul
        class="text-text-base list-disc space-y-2 pl-5 text-sm md:space-y-1"
        data-testid="delete-account-bullets"
      >
        <li>{m.delete_account_dialog_bullet_profile()}</li>
        <li>{m.delete_account_dialog_bullet_messages()}</li>
        <li>{m.delete_account_dialog_bullet_reactions()}</li>
        <li>
          {m.delete_account_dialog_bullet_owned_communities_before_bold()}<strong>{m.delete_account_dialog_bullet_owned_communities_bold()}</strong>
        </li>
        <li>{m.delete_account_dialog_bullet_memberships()}</li>
        <li>{m.delete_account_dialog_bullet_2fa()}</li>
      </ul>

      <div class="space-y-1.5">
        <Label
          for="delete-confirm-username"
          class="text-text-muted text-xs font-semibold uppercase"
        >
          {m.delete_account_dialog_label_confirm_before_username()}<code class="text-text-bright font-mono">{username}</code>{m.delete_account_dialog_label_confirm_after_username()}
        </Label>
        <Input
          id="delete-confirm-username"
          type="text"
          autocomplete="off"
          spellcheck={false}
          bind:value={confirmUsername}
          class="h-11 md:h-9"
          data-testid="delete-account-username-input"
        />
      </div>

      <AlertDialog.Footer>
        <AlertDialog.Cancel>{m.delete_account_dialog_cancel()}</AlertDialog.Cancel>
        <Button
          variant="destructive"
          onclick={goNext}
          disabled={!usernameMatches}
          data-testid="delete-account-next"
        >
          {m.delete_account_dialog_next()}
        </Button>
      </AlertDialog.Footer>
    {:else}
      <DeleteAccountCredentialsStep
        {username}
        {totpEnabled}
        {busy}
        {error}
        bind:password
        bind:code
        bind:backupCode
        bind:useBackup
        onsubmit={submit}
        onback={goBack}
      />
    {/if}
  </AlertDialog.Content>
</AlertDialog.Root>
