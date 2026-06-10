<script lang="ts">
  /**
   * BackupGateDialog — erzwingt das Cloud-Backup-Setup, bevor ein Self-Host-
   * Server beigetreten wird (siehe `$lib/stores/backup-gate.svelte`).
   *
   * Rendert im Root-Layout. Geöffnet wird er nur über `backupGate.ensure()`
   * (aus `addServerWithCertLogin`), wenn noch kein Backup existiert. Schließen
   * ohne Setup = Abbruch → der Beitritt wird still verworfen.
   *
   * Die Setup-Logik ist bewusst 1:1 aus `CloudBackup.svelte::handleSetup`
   * übernommen (exportierbares Keypair sicherstellen → Keys exportieren →
   * verschlüsseln → Backend ablegen → Server-Tresor aktivieren).
   * Master-Passwort wird NIEMALS persistiert oder geloggt.
   */
  import { toast } from 'svelte-sonner';
  import { goto } from '$app/navigation';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { backupGate } from '$lib/stores/backup-gate.svelte';
  import { certStore } from '$lib/identity/cert.svelte';
  import { loadKeypair } from '$lib/identity/keypair.svelte';
  import { ensureBackupCapableKeypair } from '$lib/identity/issue-flow';
  import { keyBackupState } from '$lib/identity/key-backup.svelte';
  import { serverVault } from '$lib/identity/server-vault.svelte';
  import { createBackup } from '$lib/api/credentials';
  import CloudBackupSetupForm from '$lib/components/settings/CloudBackupSetupForm.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let busy = $state(false);
  let errorMsg = $state<string | null>(null);
  // Hat der User schon ein Backup (anderes Gerät), zeigt der Dialog erst den
  // Restore-Pfad. „Stattdessen neu einrichten" schaltet auf das Setup-Formular.
  let forceSetup = $state(false);
  let showRestore = $derived(!!backupGate.restoreCertId && !forceSetup);

  function handleOpenChange(next: boolean): void {
    // Schließen ohne abgeschlossenes Setup = Abbruch des Beitritts.
    if (!next) {
      forceSetup = false;
      backupGate.resolve(false);
    }
  }

  /** Restore: zur getesteten /recover-Seite (stellt Keypair + Cert + Server-
   *  Vault korrekt wieder her). Der aktuelle Beitritt wird abgebrochen; nach
   *  der Wiederherstellung tritt der User einfach erneut bei (dann ohne Gate). */
  function goRestore(): void {
    if (busy) return;
    const cid = backupGate.restoreCertId;
    const label = backupGate.restoreDeviceLabel;
    if (!cid) return;
    busy = true;
    backupGate.resolve(false);
    void goto(
      `/recover?cert_id=${encodeURIComponent(cid)}&device_label=${encodeURIComponent(label)}`
    );
  }

  async function handleSetup(password: string): Promise<void> {
    errorMsg = null;
    busy = true;
    try {
      // Backup braucht ein exportierbares Keypair. Ist das aktuelle non-extractable
      // (Default = XSS-Schutz), erzeugt ensureBackupCapableKeypair einmalig ein
      // exportierbares + stellt das Cert neu aus.
      let keypair = await loadKeypair();
      if (!keypair || !keypair.privateKey.extractable) {
        keypair = await ensureBackupCapableKeypair();
      }
      // Cert kann gerade neu ausgestellt worden sein → frische cert_id aus dem Store.
      const activeCertId = certStore.cert?.claims.cert_id;
      if (!activeCertId) {
        errorMsg = m.cloud_backup_error_no_keypair();
        return;
      }

      const [privateKeyJwk, publicKeyJwk] = await Promise.all([
        crypto.subtle.exportKey('jwk', keypair.privateKey),
        crypto.subtle.exportKey('jwk', keypair.publicKey)
      ]);

      const blob = await keyBackupState.encrypt(privateKeyJwk, publicKeyJwk, password);
      const deviceLabel = certStore.cert?.claims.device_label ?? 'Unbekanntes Gerät';
      await createBackup(activeCertId, blob, deviceLabel.slice(0, 64) || 'Backup');

      // E2E-Server-Vault aktivieren (gleicher Master-Passwort-Key). Best-effort:
      // scheitert das, bleibt das Keypair-Backup trotzdem gültig.
      try { await serverVault.unlockForSetup(password); } catch { /* Vault degradiert still */ }

      toast.success(m.cloud_backup_toast_saved(), {
        description: m.cloud_backup_toast_saved_desc()
      });
      backupGate.resolve(true);
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : m.cloud_backup_error_unknown_backup();
    } finally {
      busy = false;
    }
  }
</script>

<Dialog.Root open={backupGate.open} onOpenChange={handleOpenChange}>
  <Dialog.Content data-testid="backup-gate-dialog">
    {#if showRestore}
      <Dialog.Header>
        <Dialog.Title>{m.backup_gate_restore_title()}</Dialog.Title>
        <Dialog.Description>
          {m.backup_gate_restore_body({ device: backupGate.restoreDeviceLabel })}
        </Dialog.Description>
      </Dialog.Header>
      <div class="flex flex-col gap-2 pt-2">
        <Button onclick={goRestore} data-testid="backup-gate-restore-btn">
          {m.backup_gate_restore_btn()}
        </Button>
        <Button
          variant="ghost"
          onclick={() => (forceSetup = true)}
          data-testid="backup-gate-setup-instead-btn"
        >
          {m.backup_gate_restore_setup_instead()}
        </Button>
      </div>
    {:else}
      <Dialog.Header>
        <Dialog.Title>{m.backup_gate_dialog_title()}</Dialog.Title>
        <Dialog.Description>{m.backup_gate_dialog_description()}</Dialog.Description>
      </Dialog.Header>
      <CloudBackupSetupForm
        onSubmit={handleSetup}
        onCancel={() => backupGate.resolve(false)}
        {busy}
        error={errorMsg}
      />
    {/if}
  </Dialog.Content>
</Dialog.Root>
