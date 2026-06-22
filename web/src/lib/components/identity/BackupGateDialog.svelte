<script lang="ts">
  /**
   * BackupGateDialog — erzwingt den Wiederherstellungs-Schlüssel, bevor ein
   * Self-Host-Server beigetreten wird (siehe `$lib/stores/backup-gate.svelte`).
   *
   * Läuft über den vereinheitlichten Backup-Flow (`backup-flow.ts`,
   * Account-Key-Modell): hat der Account schon einen Schlüssel, gibt es NUR
   * noch "Schlüssel eingeben" (flowMode 'enter') — ein zweiter, abweichender
   * Schlüssel ist nicht mehr möglich. Erst-Setup zeigt das Erstellen-Formular.
   *
   * Rendert im Root-Layout; geöffnet nur über `backupGate.ensure()`. Schließen
   * ohne Abschluss = Abbruch → der Beitritt wird still verworfen. Nach Erfolg
   * resolved der Gate und der Beitritt läuft automatisch weiter.
   * Master-Passwort wird NIEMALS persistiert oder geloggt.
   */
  import { toast } from 'svelte-sonner';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { backupGate } from '$lib/stores/backup-gate.svelte';
  import {
    detectBackupFlowMode,
    setupOrUnlock,
    WrongRecoveryKeyError,
    type BackupFlowMode
  } from '$lib/identity/backup-flow';
  import CloudBackupSetupForm from '$lib/components/settings/CloudBackupSetupForm.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let busy = $state(false);
  let errorMsg = $state<string | null>(null);
  let flowMode = $state<BackupFlowMode | null>(null);

  // Beim Öffnen den Modus bestimmen (create vs enter). $effect statt onMount,
  // weil der Dialog dauerhaft gemountet ist und nur open toggelt.
  $effect(() => {
    if (!backupGate.open) {
      flowMode = null;
      errorMsg = null;
      busy = false;
      return;
    }
    if (flowMode === null) {
      // Cancel-Flag: schließt der User den Dialog, bevor die Erkennung
      // zurückkommt, darf das verspätete Resultat NICHT mehr flowMode setzen —
      // sonst überspringt der !==null-Guard beim Wiederöffnen die Neu-Erkennung
      // und zeigt das falsche Formular (create vs enter).
      let live = true;
      void detectBackupFlowMode().then((mode) => {
        if (live) flowMode = mode;
      });
      return () => {
        live = false;
      };
    }
  });

  function handleOpenChange(next: boolean): void {
    // Schließen ohne abgeschlossenes Setup = Abbruch des Beitritts.
    if (!next) backupGate.resolve(false);
  }

  async function handleSubmit(password: string): Promise<void> {
    errorMsg = null;
    busy = true;
    try {
      await setupOrUnlock(password);
      toast.success(m.cloud_backup_toast_saved(), {
        description: m.cloud_backup_toast_saved_desc()
      });
      backupGate.resolve(true);
    } catch (err) {
      errorMsg =
        err instanceof WrongRecoveryKeyError
          ? m.backup_flow_wrong_key()
          : err instanceof Error
            ? err.message
            : m.cloud_backup_error_unknown_backup();
    } finally {
      busy = false;
    }
  }
</script>

<Dialog.Root open={backupGate.open} onOpenChange={handleOpenChange}>
  <Dialog.Content data-testid="backup-gate-dialog">
    <Dialog.Header>
      <Dialog.Title>
        {flowMode === 'enter' ? m.backup_gate_enter_title() : m.backup_gate_dialog_title()}
      </Dialog.Title>
      <Dialog.Description>
        {flowMode === 'enter'
          ? m.backup_gate_enter_description()
          : m.backup_gate_dialog_description()}
      </Dialog.Description>
    </Dialog.Header>
    {#if flowMode !== null}
      <CloudBackupSetupForm
        onSubmit={handleSubmit}
        onCancel={() => backupGate.resolve(false)}
        {busy}
        error={errorMsg}
        {flowMode}
      />
    {:else}
      <p class="text-text-muted text-sm">{m.backup_gate_checking()}</p>
    {/if}
  </Dialog.Content>
</Dialog.Root>
