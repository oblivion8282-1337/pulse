/**
 * Globaler Onboarding-State (Block 2.D).
 *
 * Hält den showBackupStep-Flag der als Trigger für den BackupSetupStep-Dialog
 * dient. Wird nach dem Issue-Flow gesetzt wenn kein Backup existiert und der
 * User noch nicht entschieden hat.
 *
 * Persistenz: Backend-first (chat-gateway /me/preferences/backup-onboarding),
 * localStorage `pulse.backup_onboarding_decided` als Write-Through-Cache
 * (Offline-Fallback im nächsten Boot bevor Backend antwortet).
 *
 * Sync-Logik:
 *  1. `init()`: fragt Backend (< 3s-Timeout). Bei Erfolg → In-Memory + LS-Cache.
 *     Bei Fehler → LS-Fallback. Muss vor `hasDecided()` / `triggerIfNeeded()`
 *     aufgerufen werden.
 *  2. `markDecided()`: schreibt Backend + LS synchron. Bei Backend-Fehler
 *     → LS-only (offline-safe), `syncFailed = true` → Aufrufer zeigt Toast.
 */

import { request, ApiError } from '$lib/api/client';

const LS_KEY = 'pulse.backup_onboarding_decided';

type BackupOnboardingOut = {
  decided: boolean;
  decision: 'skipped' | 'configured' | null;
  decided_at: string | null;
};

class OnboardingState {
  showBackupStep = $state(false);

  /** true wenn Backend-PATCH fehlschlug → Aufrufer soll Toast anzeigen. */
  syncFailed = $state(false);

  /** In-Memory-Flag: gesetzt nach init() oder markDecided(). */
  private _decided = false;

  /** Schreibt den entschiedenen State in den localStorage-Cache. */
  private _writeLocalStorage(decision: 'skipped' | 'configured'): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(
        LS_KEY,
        JSON.stringify({ decided_at: new Date().toISOString(), decision })
      );
    } catch {
      // Quota/SecurityError (Safari ITP, Private-Browsing-Quota): ignorieren.
    }
  }

  /** Liest den entschiedenen State aus dem localStorage-Cache.
   *  Gibt `null` zurück wenn noch kein Eintrag existiert. */
  private _readLocalStorage(): { decision: 'skipped' | 'configured'; decided_at: string } | null {
    if (typeof localStorage === 'undefined') return null;
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { decision?: string; decided_at?: string };
      if (parsed.decision === 'skipped' || parsed.decision === 'configured') {
        return { decision: parsed.decision, decided_at: parsed.decided_at ?? '' };
      }
    } catch {
      // korrupter Eintrag → als null behandeln
    }
    return null;
  }

  /**
   * Initialisiert den State beim Boot / nach Login.
   * Fragt das Backend (max. 3 s); bei Fehler → LS-Fallback.
   * Muss vor `hasDecided()` aufgerufen werden.
   */
  async init(): Promise<void> {
    // Optimistisch: LS sofort einlesen damit hasDecided() nicht kurz falsch ist.
    const ls = this._readLocalStorage();
    if (ls) {
      this._decided = true;
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      let data: BackupOnboardingOut;
      try {
        data = await request<BackupOnboardingOut>('/me/preferences/backup-onboarding', {
          signal: controller.signal
        });
      } finally {
        clearTimeout(timeout);
      }
      if (data.decided) {
        this._decided = true;
        // Schreib-Through: LS-Cache aktualisieren.
        if (data.decision) this._writeLocalStorage(data.decision);
      } else {
        // Backend sagt undecided → LS-Cache löschen (anderes Gerät könnte
        // einen veralteten Entry haben, Backend ist Wahrheit).
        if (typeof localStorage !== 'undefined') {
          try { localStorage.removeItem(LS_KEY); } catch { /* ignore */ }
        }
        this._decided = false;
      }
    } catch {
      // Netzwerkfehler / Timeout → LS-Fallback bleibt erhalten.
    }
  }

  /** Gibt true zurück wenn der User bereits entschieden hat. */
  hasDecided(): boolean {
    return this._decided;
  }

  /**
   * Markiert die Entscheidung als getroffen und schließt den Dialog.
   * Schreibt Backend + LS. Bei Backend-Fehler → `syncFailed = true`.
   */
  async markDecided(decision: 'skipped' | 'configured'): Promise<void> {
    this._decided = true;
    this._writeLocalStorage(decision);
    this.showBackupStep = false;
    this.syncFailed = false;

    try {
      await request('/me/preferences/backup-onboarding', {
        method: 'PATCH',
        body: { decision }
      });
    } catch (err) {
      // 409 = already_decided — das ist OK (idempotent).
      if (err instanceof ApiError && err.status === 409) return;
      // Alles andere (5xx, Netzwerk) → offline-safe, aber User warnen.
      this.syncFailed = true;
    }
  }

  /** Trigger vom Issue-Flow: zeigt den Step wenn noch keine Entscheidung vorliegt. */
  triggerIfNeeded(): void {
    if (this._decided) return;
    this.showBackupStep = true;
  }

  /** Wird beim Sign-Out aufgerufen um den Dialog zurückzusetzen. */
  reset(): void {
    this.showBackupStep = false;
    this._decided = false;
    this.syncFailed = false;
  }
}

export const onboardingState = new OnboardingState();
