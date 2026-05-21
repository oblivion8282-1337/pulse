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
      error = 'Bitte Passwort eingeben.';
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
          error = 'Backup-Code darf nicht leer sein.';
          return;
        }
        input.backup_code = normalized;
      } else {
        const digits = stripTotpFormatting(code);
        if (digits.length !== 6) {
          error = 'Bitte 6-stelligen Code eingeben.';
          return;
        }
        input.code = digits;
      }
    }
    error = null;
    busy = true;
    try {
      await deleteAccount(input);
      toast.success('Account gelöscht. Auf Wiedersehen.');
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
        toast.error('Username stimmt nicht überein. Bitte erneut bestätigen.');
        password = '';
        code = '';
        backupCode = '';
        step = 'warn';
        return;
      }
      if (err.status === 401) {
        toast.error('Passwort oder Code falsch.');
        password = '';
        code = '';
        backupCode = '';
        return;
      }
      if (err.status === 429) {
        toast.error('Zu viele Versuche. Bitte warte und versuche es später nochmal.');
        return;
      }
      if (err.status === 503) {
        toast.error('Account-Löschung ist auf diesem Server nicht verfügbar.', {
          description: 'Bitte wende dich an den Admin.'
        });
        return;
      }
    }
    error = (err as Error).message ?? 'Unbekannter Fehler';
  }
</script>

<AlertDialog.Root bind:open>
  <AlertDialog.Content data-testid="delete-account-dialog">
    {#if step === 'warn'}
      <AlertDialog.Header>
        <AlertDialog.Title>
          <span class="text-destructive flex items-center gap-2">
            <TriangleAlertIcon class="size-5" />
            Bist du sicher?
          </span>
        </AlertDialog.Title>
        <AlertDialog.Description>
          Diese Aktion ist <strong>dauerhaft</strong>. Folgendes wird unwiderruflich gelöscht:
        </AlertDialog.Description>
      </AlertDialog.Header>

      <ul
        class="text-text-base list-disc space-y-2 pl-5 text-sm md:space-y-1"
        data-testid="delete-account-bullets"
      >
        <li>Dein Profil (Username, Email, Avatar)</li>
        <li>Alle deine Nachrichten in allen Channels und DMs</li>
        <li>Alle deine Reaktionen</li>
        <li>
          Alle Server, in denen du Owner bist — <strong>inkl. aller darin enthaltenen Daten</strong>
        </li>
        <li>Deine Mitgliedschaften in fremden Servern</li>
        <li>Alle 2FA-Backup-Codes und Sessions</li>
      </ul>

      <div class="space-y-1.5">
        <Label
          for="delete-confirm-username"
          class="text-text-muted text-xs font-semibold uppercase"
        >
          Tippe <code class="text-text-bright font-mono">{username}</code> zur Bestätigung ein
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
        <AlertDialog.Cancel>Abbrechen</AlertDialog.Cancel>
        <Button
          variant="destructive"
          onclick={goNext}
          disabled={!usernameMatches}
          data-testid="delete-account-next"
        >
          Weiter
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
