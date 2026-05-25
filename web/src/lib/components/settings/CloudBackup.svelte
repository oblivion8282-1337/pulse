<script lang="ts">
  /**
   * Cloud-Backup — verschlüsselt das lokale Ed25519-Keypair mit einem
   * Master-Passwort und speichert den Blob server-seitig (Block 2.C).
   *
   * States: idle → setup/recover → (async) → idle
   * Master-Passwort wird NIEMALS persistiert oder geloggt.
   */
  import { onMount } from 'svelte';
  import { toast } from 'svelte-sonner';
  import EyeIcon from '@lucide/svelte/icons/eye';
  import EyeOffIcon from '@lucide/svelte/icons/eye-off';
  import LoaderIcon from '@lucide/svelte/icons/loader-circle';
  import CloudIcon from '@lucide/svelte/icons/cloud';
  import { certStore } from '$lib/identity/cert.svelte';
  import { loadKeypair } from '$lib/identity/keypair.svelte';
  import { keyBackupState, BackupDecryptError } from '$lib/identity/key-backup.svelte';
  import { createBackup, getBackup, deleteBackup, reconstructBlob } from '$lib/api/credentials';
  import type { BackupFetchResponse } from '$lib/api/credentials';
  import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';

  type ViewState = 'idle' | 'setup' | 'recover';

  let viewState = $state<ViewState>('idle');
  let existingBackup = $state<BackupFetchResponse | null>(null);
  let loadingStatus = $state(true);

  // Formular-State (nur in setup/recover aktiv)
  let password = $state('');
  let passwordConfirm = $state('');
  let showPassword = $state(false);
  let showConfirm = $state(false);
  let errorMsg = $state<string | null>(null);
  let busy = $state(false);

  // Delete-Confirm-Dialog
  let deleteDialogOpen = $state(false);

  // Abgeleitete Werte
  const certId = $derived(certStore.cert?.claims.cert_id ?? null);
  const hasBackup = $derived(existingBackup !== null);
  const passwordStrong = $derived(password.length >= 12);
  const passwordsMatch = $derived(password === passwordConfirm);

  function formatDate(iso: string): string {
    try {
      return new Intl.DateTimeFormat('de-DE', { dateStyle: 'long' }).format(new Date(iso));
    } catch {
      return iso;
    }
  }

  async function loadStatus() {
    if (!certId) return;
    loadingStatus = true;
    try {
      existingBackup = await getBackup(certId);
    } catch {
      existingBackup = null;
    } finally {
      loadingStatus = false;
    }
  }

  onMount(loadStatus);

  function openSetup() {
    password = '';
    passwordConfirm = '';
    showPassword = false;
    showConfirm = false;
    errorMsg = null;
    viewState = 'setup';
  }

  function openRecover() {
    password = '';
    showPassword = false;
    errorMsg = null;
    viewState = 'recover';
  }

  function cancelFlow() {
    password = '';
    passwordConfirm = '';
    errorMsg = null;
    viewState = 'idle';
  }

  async function handleSetup() {
    if (!certId || busy) return;
    errorMsg = null;

    if (!passwordStrong) {
      errorMsg = 'Master-Passwort muss mindestens 12 Zeichen haben.';
      return;
    }
    if (!passwordsMatch) {
      errorMsg = 'Passwörter stimmen nicht überein.';
      return;
    }

    busy = true;
    try {
      const keypair = await loadKeypair();
      if (!keypair) {
        errorMsg = 'Kein lokales Keypair gefunden. Bitte neu anmelden.';
        return;
      }

      // Extractable prüfen — non-extractable Keys können nicht gesichert werden
      if (!keypair.privateKey.extractable) {
        errorMsg =
          'Dieses Keypair wurde ohne Export-Erlaubnis erstellt. Bitte melde dich neu an, ' +
          'um ein backup-fähiges Keypair zu erhalten.';
        return;
      }

      const [privateKeyJwk, publicKeyJwk] = await Promise.all([
        crypto.subtle.exportKey('jwk', keypair.privateKey),
        crypto.subtle.exportKey('jwk', keypair.publicKey)
      ]);

      const blob = await keyBackupState.encrypt(privateKeyJwk, publicKeyJwk, password);

      const deviceLabel = certStore.cert?.claims.device_label ?? 'Unbekanntes Gerät';
      const resp = await createBackup(certId, blob, deviceLabel.slice(0, 64) || 'Backup');
      existingBackup = { ...blob.kdf, ...blob.cipher, cert_id: resp.cert_id, device_label: deviceLabel, created_at: resp.created_at } as unknown as BackupFetchResponse;
      // Backup-Status neu laden für korrekten Response-Shape
      existingBackup = await getBackup(certId);

      toast.success('Backup gespeichert', {
        description: 'Dein verschlüsseltes Keypair-Backup wurde in der Cloud gespeichert.'
      });
      cancelFlow();
    } catch (err) {
      if (err instanceof Error) {
        errorMsg = err.message;
      } else {
        errorMsg = 'Unbekannter Fehler beim Backup.';
      }
    } finally {
      busy = false;
      // Passwort sofort leeren
      password = '';
      passwordConfirm = '';
    }
  }

  async function handleRecover() {
    if (!certId || !existingBackup || busy) return;
    errorMsg = null;
    busy = true;
    try {
      const blob = reconstructBlob(existingBackup);
      const keypair = await keyBackupState.decrypt(blob, password);

      // Keys in IndexedDB importieren
      const [privateKey, publicKey] = await Promise.all([
        crypto.subtle.importKey('jwk', keypair.privateKey, { name: 'Ed25519' }, true, ['sign']),
        crypto.subtle.importKey('jwk', keypair.publicKey, { name: 'Ed25519' }, true, ['verify'])
      ]);
      const { saveKeypair } = await import('$lib/identity/keypair.svelte');
      await saveKeypair({ type: 'webcrypto', privateKey, publicKey });

      toast.success('Recovery erfolgreich', {
        description: 'Deine Schlüssel wurden aus dem Backup wiederhergestellt.'
      });
      cancelFlow();
    } catch (err) {
      if (err instanceof BackupDecryptError) {
        errorMsg = 'Falsches Master-Passwort oder defektes Backup.';
      } else if (err instanceof Error) {
        errorMsg = err.message;
      } else {
        errorMsg = 'Unbekannter Fehler bei der Wiederherstellung.';
      }
    } finally {
      busy = false;
      password = '';
    }
  }

  async function handleDelete() {
    if (!certId) return;
    deleteDialogOpen = false;
    busy = true;
    try {
      await deleteBackup(certId);
      existingBackup = null;
      toast.success('Backup gelöscht');
    } catch (err) {
      toast.error('Löschen fehlgeschlagen', { description: (err as Error).message });
    } finally {
      busy = false;
    }
  }
</script>

<section
  class="border-border bg-bg-input/40 flex flex-col gap-3 rounded-2xl border p-4"
  data-testid="cloud-backup-section"
>
  <div class="flex items-start gap-3">
    <span class="bg-bg-input text-text-muted flex size-9 shrink-0 items-center justify-center rounded-full">
      <CloudIcon class="size-5" />
    </span>
    <div class="flex flex-col gap-0.5">
      <span class="text-text-bright text-sm font-medium">Cloud-Backup</span>
      <span class="text-text-muted text-xs">
        Verschlüsseltes Backup deiner Geräte-Schlüssel. Nur du kannst es entschlüsseln.
      </span>
    </div>
  </div>

  {#if !certId}
    <p class="text-text-muted text-xs">Kein aktives Identitäts-Cert — bitte neu anmelden.</p>
  {:else if loadingStatus}
    <div class="text-text-muted flex items-center gap-2 text-xs">
      <LoaderIcon class="size-4 animate-spin" />
      <span>Status wird geladen…</span>
    </div>
  {:else if viewState === 'idle'}
    <!-- Status-Anzeige -->
    {#if hasBackup}
      <p class="text-text-muted text-xs">
        Backup vom
        <span class="text-text-base font-medium">{formatDate(existingBackup!.created_at)}</span>
        · Gerät: {existingBackup!.device_label}
      </p>
      <div class="flex flex-wrap gap-2">
        <button
          type="button"
          onclick={openSetup}
          class="bg-bg-input text-text-base hover:bg-bg-hover rounded-md px-3 py-2 text-xs font-medium transition-colors md:py-1.5"
          data-testid="backup-update-btn"
        >
          Backup aktualisieren
        </button>
        <button
          type="button"
          onclick={openRecover}
          class="bg-bg-input text-text-base hover:bg-bg-hover rounded-md px-3 py-2 text-xs font-medium transition-colors md:py-1.5"
          data-testid="backup-recover-btn"
        >
          Wiederherstellen
        </button>
        <button
          type="button"
          onclick={() => (deleteDialogOpen = true)}
          disabled={busy}
          class="text-destructive bg-destructive/10 hover:bg-destructive/20 rounded-md px-3 py-2 text-xs font-medium transition-colors disabled:opacity-50 md:py-1.5"
          data-testid="backup-delete-btn"
        >
          Backup löschen
        </button>
      </div>
    {:else}
      <p class="text-text-muted text-xs">Kein Backup vorhanden.</p>
      <button
        type="button"
        onclick={openSetup}
        class="accent-gradient self-start rounded-md px-3 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 md:py-1.5"
        data-testid="backup-setup-btn"
      >
        Backup einrichten
      </button>
    {/if}

  {:else if viewState === 'setup'}
    <!-- Master-Passwort Setup-Formular -->
    <div class="flex flex-col gap-3">
      <div class="flex flex-col gap-1">
        <label for="backup-pw" class="text-text-muted text-xs font-medium">Master-Passwort</label>
        <div class="relative">
          <input
            id="backup-pw"
            type={showPassword ? 'text' : 'password'}
            bind:value={password}
            placeholder="Mindestens 12 Zeichen"
            class="border-border bg-bg-input text-text-base placeholder:text-text-muted w-full rounded-lg border px-3 py-2 pr-10 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50"
            data-testid="backup-password-input"
          />
          <button
            type="button"
            onclick={() => (showPassword = !showPassword)}
            class="text-text-muted hover:text-text-base absolute right-3 top-1/2 -translate-y-1/2"
            aria-label={showPassword ? 'Passwort verbergen' : 'Passwort anzeigen'}
          >
            {#if showPassword}
              <EyeOffIcon class="size-4" />
            {:else}
              <EyeIcon class="size-4" />
            {/if}
          </button>
        </div>
        {#if password.length > 0}
          <span class="text-xs {passwordStrong ? 'text-emerald-500' : 'text-amber-500'}">
            {passwordStrong ? 'Stark genug' : `Noch ${12 - password.length} Zeichen nötig`}
          </span>
        {/if}
      </div>

      <div class="flex flex-col gap-1">
        <label for="backup-pw-confirm" class="text-text-muted text-xs font-medium">
          Passwort bestätigen
        </label>
        <div class="relative">
          <input
            id="backup-pw-confirm"
            type={showConfirm ? 'text' : 'password'}
            bind:value={passwordConfirm}
            placeholder="Nochmal eingeben"
            class="border-border bg-bg-input text-text-base placeholder:text-text-muted w-full rounded-lg border px-3 py-2 pr-10 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50"
            data-testid="backup-password-confirm-input"
          />
          <button
            type="button"
            onclick={() => (showConfirm = !showConfirm)}
            class="text-text-muted hover:text-text-base absolute right-3 top-1/2 -translate-y-1/2"
            aria-label={showConfirm ? 'Passwort verbergen' : 'Passwort anzeigen'}
          >
            {#if showConfirm}
              <EyeOffIcon class="size-4" />
            {:else}
              <EyeIcon class="size-4" />
            {/if}
          </button>
        </div>
        {#if passwordConfirm.length > 0}
          <span class="text-xs {passwordsMatch ? 'text-emerald-500' : 'text-destructive'}">
            {passwordsMatch ? 'Stimmt überein' : 'Passwörter stimmen nicht überein'}
          </span>
        {/if}
      </div>

      {#if errorMsg}
        <p class="text-destructive text-xs" role="alert" data-testid="backup-error">{errorMsg}</p>
      {/if}

      <div class="flex gap-2">
        <button
          type="button"
          onclick={handleSetup}
          disabled={busy || !passwordStrong || !passwordsMatch}
          class="accent-gradient rounded-md px-3 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50 md:py-1.5"
          data-testid="backup-confirm-btn"
        >
          {#if busy || keyBackupState.encrypting}
            <LoaderIcon class="mr-1 inline size-4 animate-spin" />Wird verschlüsselt…
          {:else}
            Backup speichern
          {/if}
        </button>
        <button
          type="button"
          onclick={cancelFlow}
          disabled={busy}
          class="bg-bg-input text-text-base hover:bg-bg-hover rounded-md px-3 py-2 text-sm font-medium transition-colors disabled:opacity-50 md:py-1.5"
        >
          Abbrechen
        </button>
      </div>
    </div>

  {:else if viewState === 'recover'}
    <!-- Recovery-Formular -->
    <div class="flex flex-col gap-3">
      <p class="text-text-muted text-xs">
        Gib dein Master-Passwort ein, um die Schlüssel aus dem Backup wiederherzustellen.
      </p>
      <div class="flex flex-col gap-1">
        <label for="recover-pw" class="text-text-muted text-xs font-medium">Master-Passwort</label>
        <div class="relative">
          <input
            id="recover-pw"
            type={showPassword ? 'text' : 'password'}
            bind:value={password}
            placeholder="Master-Passwort eingeben"
            class="border-border bg-bg-input text-text-base placeholder:text-text-muted w-full rounded-lg border px-3 py-2 pr-10 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50"
            data-testid="recover-password-input"
          />
          <button
            type="button"
            onclick={() => (showPassword = !showPassword)}
            class="text-text-muted hover:text-text-base absolute right-3 top-1/2 -translate-y-1/2"
            aria-label={showPassword ? 'Passwort verbergen' : 'Passwort anzeigen'}
          >
            {#if showPassword}
              <EyeOffIcon class="size-4" />
            {:else}
              <EyeIcon class="size-4" />
            {/if}
          </button>
        </div>
      </div>

      {#if errorMsg}
        <p class="text-destructive text-xs" role="alert" data-testid="recover-error">{errorMsg}</p>
      {/if}

      <div class="flex gap-2">
        <button
          type="button"
          onclick={handleRecover}
          disabled={busy || password.length === 0}
          class="accent-gradient rounded-md px-3 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50 md:py-1.5"
          data-testid="recover-confirm-btn"
        >
          {#if busy || keyBackupState.decrypting}
            <LoaderIcon class="mr-1 inline size-4 animate-spin" />Wird entschlüsselt…
          {:else}
            Schlüssel wiederherstellen
          {/if}
        </button>
        <button
          type="button"
          onclick={cancelFlow}
          disabled={busy}
          class="bg-bg-input text-text-base hover:bg-bg-hover rounded-md px-3 py-2 text-sm font-medium transition-colors disabled:opacity-50 md:py-1.5"
        >
          Abbrechen
        </button>
      </div>
    </div>
  {/if}
</section>

<!-- Delete-Bestätigungs-Dialog -->
<AlertDialog.Root bind:open={deleteDialogOpen}>
  <AlertDialog.Content data-testid="backup-delete-dialog">
    <AlertDialog.Header>
      <AlertDialog.Title>Backup wirklich löschen?</AlertDialog.Title>
      <AlertDialog.Description>
        Du kannst dich von keinem anderen Gerät wiederherstellen, wenn das Backup gelöscht wird.
        Diese Aktion kann nicht rückgängig gemacht werden.
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel>Abbrechen</AlertDialog.Cancel>
      <Button variant="destructive" onclick={handleDelete} data-testid="backup-delete-confirm">
        Backup löschen
      </Button>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
