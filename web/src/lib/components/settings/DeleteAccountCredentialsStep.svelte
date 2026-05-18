<script lang="ts">
  /**
   * Step 2 vom Account-Löschung-Dialog — Password + (optional) 2FA-Code.
   *
   * Reine UI-Stub-Component: hält keine Submit-Logik, nur die Form-Felder
   * + Toggle-Knopf. Der Parent (`DeleteAccountDialog.svelte`) bindet die
   * Werte über `bind:` und liest sie beim Submit ab. So bleibt die Submit-/
   * Error-Mapping-Logik an einer Stelle, was die Fehler-Flows (400-zurück-
   * zu-Step-1, 401-Inputs-leeren) übersichtlich hält.
   */
  import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import * as Alert from '$lib/components/ui/alert/index.js';
  import OctagonXIcon from '@lucide/svelte/icons/octagon-x';
  import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';

  type Props = {
    username: string;
    totpEnabled: boolean;
    busy: boolean;
    error: string | null;
    password?: string;
    code?: string;
    backupCode?: string;
    useBackup?: boolean;
    onsubmit: (e: Event) => void;
    onback: () => void;
  };

  let {
    username,
    totpEnabled,
    busy,
    error,
    password = $bindable(''),
    code = $bindable(''),
    backupCode = $bindable(''),
    useBackup = $bindable(false),
    onsubmit,
    onback
  }: Props = $props();
</script>

<AlertDialog.Header>
  <AlertDialog.Title>
    <span class="text-destructive flex items-center gap-2">
      <TriangleAlertIcon class="size-5" />
      Account endgültig löschen
    </span>
  </AlertDialog.Title>
  <AlertDialog.Description>
    Bestätige mit deinem Passwort{totpEnabled ? ' und 2FA-Code' : ''}, um den Account
    <strong>{username}</strong> zu löschen.
  </AlertDialog.Description>
</AlertDialog.Header>

<form {onsubmit} class="space-y-3">
  <div class="space-y-1.5">
    <Label for="delete-password" class="text-text-muted text-xs font-semibold uppercase">
      Passwort
    </Label>
    <Input
      id="delete-password"
      type="password"
      autocomplete="current-password"
      bind:value={password}
      required
      data-testid="delete-account-password"
    />
  </div>

  {#if totpEnabled}
    {#if useBackup}
      <div class="space-y-1.5">
        <Label for="delete-backup" class="text-text-muted text-xs font-semibold uppercase">
          Backup-Code
        </Label>
        <Input
          id="delete-backup"
          type="text"
          autocapitalize="characters"
          spellcheck={false}
          bind:value={backupCode}
          required
          data-testid="delete-account-backup"
        />
      </div>
    {:else}
      <div class="space-y-1.5">
        <Label for="delete-code" class="text-text-muted text-xs font-semibold uppercase">
          Aktueller Code aus der App
        </Label>
        <Input
          id="delete-code"
          type="text"
          inputmode="numeric"
          autocomplete="one-time-code"
          bind:value={code}
          required
          maxlength={7}
          class="text-center font-mono tracking-[0.2em]"
          data-testid="delete-account-code"
        />
      </div>
    {/if}

    <button
      type="button"
      class="text-primary text-xs hover:underline"
      onclick={() => (useBackup = !useBackup)}
      data-testid="delete-account-toggle-backup"
    >
      {useBackup ? '6-stelligen Code verwenden' : 'Backup-Code verwenden'}
    </button>
  {/if}

  {#if error}
    <Alert.Root variant="destructive" data-testid="delete-account-error">
      <OctagonXIcon />
      <Alert.Description>{error}</Alert.Description>
    </Alert.Root>
  {/if}

  <AlertDialog.Footer>
    <Button
      variant="secondary"
      type="button"
      onclick={onback}
      disabled={busy}
      data-testid="delete-account-back"
    >
      Zurück
    </Button>
    <Button
      type="submit"
      variant="destructive"
      disabled={busy}
      data-testid="delete-account-submit"
    >
      {busy ? 'Löschen…' : 'Account endgültig löschen'}
    </Button>
  </AlertDialog.Footer>
</form>
