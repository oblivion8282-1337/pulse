/**
 * Globaler Onboarding-State (Block 2.D).
 *
 * Hält den showBackupStep-Flag der als Trigger für den BackupSetupStep-Dialog
 * dient. Wird nach dem Issue-Flow gesetzt wenn kein Backup existiert und der
 * User noch keine Entscheidung getroffen hat.
 *
 * Persistenz: localStorage-Key `pulse.backup_onboarding_decided` (ISO-Timestamp).
 * TODO: Backend-Sync via PATCH /me/preferences/backup_onboarding wenn der
 *       Endpoint im chat-gateway implementiert ist.
 */

const LS_KEY = 'pulse.backup_onboarding_decided';

class OnboardingState {
  showBackupStep = $state(false);

  /** Gibt true zurück wenn der User bereits entschieden hat (skip oder configured). */
  hasDecided(): boolean {
    if (typeof localStorage === 'undefined') return false;
    return !!localStorage.getItem(LS_KEY);
  }

  /** Markiert die Entscheidung als getroffen und schließt den Dialog. */
  markDecided(decision: 'skipped' | 'configured'): void {
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(
          LS_KEY,
          JSON.stringify({ decided_at: new Date().toISOString(), decision })
        );
      } catch {
        // Quota/SecurityError (Safari ITP, Private-Browsing-Quota): still ok,
        // Dialog erscheint beim nächsten Login erneut — nicht ideal, aber kein Crash.
      }
    }
    this.showBackupStep = false;
  }

  /** Trigger vom Issue-Flow: zeigt den Step wenn noch keine Entscheidung vorliegt. */
  triggerIfNeeded(): void {
    if (this.hasDecided()) return;
    this.showBackupStep = true;
  }

  /** Wird beim Sign-Out aufgerufen um den Dialog zurückzusetzen. */
  reset(): void {
    this.showBackupStep = false;
  }
}

export const onboardingState = new OnboardingState();
