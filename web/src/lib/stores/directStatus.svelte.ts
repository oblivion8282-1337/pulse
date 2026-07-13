/**
 * Sichtbarer Fehlzustand des Direktpfads für Direct-only-Server (App-Host,
 * kein Relay-Fallback mehr). Gefüttert von transportFetch/gateway-connection,
 * gelesen von der Server-Leiste (Tooltip) und dem Vertrauens-Dialog
 * (Fingerprint-Wechsel). Ein erfolgreicher Kontakt räumt den Eintrag weg.
 */

import type { DirectFailureReason } from '$lib/direct/policy';

class DirectStatusStore {
  /** Letzter Fehlgrund pro Instanz-ID (nur Direct-only-Server melden hier). */
  failures = $state<Record<string, DirectFailureReason>>({});
  /** Instanz-ID, für die der "Neuer Identität vertrauen"-Dialog offen ist. */
  trustPrompt = $state<string | null>(null);

  report(instanceId: string, reason: DirectFailureReason): void {
    if (this.failures[instanceId] !== reason) {
      this.failures = { ...this.failures, [instanceId]: reason };
    }
    // Fingerprint-Wechsel ist ein Entscheidungs-Moment, kein Dauerzustand:
    // den Dialog genau einmal öffnen, bis der User entschieden hat.
    if (reason === 'fingerprint-mismatch' && this.trustPrompt === null) {
      this.trustPrompt = instanceId;
    }
  }

  clear(instanceId: string): void {
    if (!(instanceId in this.failures)) return;
    const next = { ...this.failures };
    delete next[instanceId];
    this.failures = next;
    if (this.trustPrompt === instanceId) this.trustPrompt = null;
  }

  dismissTrustPrompt(): void {
    this.trustPrompt = null;
  }

  clearAll(): void {
    this.failures = {};
    this.trustPrompt = null;
  }
}

export const directStatus = new DirectStatusStore();
