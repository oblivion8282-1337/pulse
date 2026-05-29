import { me } from '$lib/api/auth';
import { clearTokens, loadTokens } from '$lib/api/storage';
import { readState } from './readState.svelte';
import { userCache } from './users.svelte';
import { capabilities } from './capabilities.svelte';
import { serverAdmin } from './serverAdmin.svelte';
import { settings } from './settings.svelte';
import { hydrateServerSections } from '$lib/settings-registry';
import { privacy } from './privacy.svelte';
import { onboardingState } from '$lib/stores/onboardingState.svelte';
import { resetServerScopedStores } from './multi-server-reset';
import { goto } from '$app/navigation';
import type { User } from '$lib/api/types';
import { gatewayPool } from '$lib/ws/gateway-pool.svelte';
import { sessionTokens } from '$lib/api/session_tokens.svelte';
import { serversStore } from '$lib/api/servers.svelte';
import { certStore } from '$lib/identity/cert.svelte';
import { keypairStore } from '$lib/identity/keypair.svelte';
import { profileStatementStore } from '$lib/identity/profile-statement.svelte';
import { stopProfileRefresh } from '$lib/identity/profile-refresh.svelte';
import { stopCertRotation } from '$lib/identity/cert-rotation.svelte';

const ACCESS_KEY = 'dcc.tokens.access';

class AuthStore {
  user = $state<User | null>(null);
  loading = $state(false);
  private _hydrateInflight: Promise<void> | null = null;

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', (e) => {
        if (e.key === ACCESS_KEY && !e.newValue) {
          this.signOut();
        }
      });
    }
  }

  get isAuthenticated(): boolean {
    return this.user !== null;
  }

  hydrate(): Promise<void> {
    if (this._hydrateInflight) return this._hydrateInflight;
    if (this.user) return Promise.resolve();
    if (!loadTokens()) {
      this.user = null;
      return Promise.resolve();
    }
    this._hydrateInflight = this._doHydrate();
    return this._hydrateInflight;
  }

  private async _doHydrate(): Promise<void> {
    this.loading = true;
    try {
      this.user = await me();
      if (this.user) {
        readState.hydrateForUser(this.user.id);
        // Schritt 3b: pull server-backed settings sections so plugins
        // that opted into cross-device sync see the latest state.
        // Best-effort; a network blip just leaves the local slice in
        // place, the next mutation will push it back up.
        void hydrateServerSections();
        // Fix 2: Cert + Timer nach Tab-Reload/SSO-Hydrate nachholen.
        // Dynamische Imports vermeiden Circular-Dep (identity-Module importieren auth).
        // RecoveryAvailableError → Redirect zu /recover (z.B. wenn der User auf
        // einem neuen Gerät den Tab reopened ohne vorher den Setup-Flow zu
        // sehen). Sonstige Fehler werden gracefully geschluckt.
        import('$lib/identity/issue-flow')
          .then(async ({ runIssueFlow, RecoveryAvailableError }) => {
            try {
              await runIssueFlow();
            } catch (err) {
              if (err instanceof RecoveryAvailableError) {
                const params = new URLSearchParams({
                  cert_id: err.certId,
                  device_label: err.deviceLabel,
                });
                await goto(`/recover?${params.toString()}`, { replaceState: true });
                return; // Recovery-Redirect — Timer erst nach erneutem Login starten
              }
              // Andere Fehler (Netzwerk etc.): Timer trotzdem starten. Die
              // Rotation-Callbacks wiederholen den Versuch beim nächsten Interval.
              // Kein rethrow — wir wollen immer zu startProfileRefresh/startCertRotation.
            }
            const [{ startProfileRefresh }, { startCertRotation }] = await Promise.all([
              import('$lib/identity/profile-refresh.svelte'),
              import('$lib/identity/cert-rotation.svelte'),
            ]);
            startProfileRefresh();
            startCertRotation();
          })
          .catch(() => {/* silent — degradiert gracefully */});
      }
    } catch {
      clearTokens();
      this.user = null;
    } finally {
      this.loading = false;
      this._hydrateInflight = null;
    }
  }

  setUser(user: User): void {
    this.user = user;
    readState.hydrateForUser(user.id);
    // Same Schritt-3b cross-device hydrate as in _doHydrate. Triggered
    // by the login flow's `auth.setUser(...)` call right after the
    // tokens are saved.
    void hydrateServerSections();
  }

  signOut(): void {
    clearTokens();
    this.user = null;
    // Server-scoped Stores: Helper aus Phase 4.5 — leert 15 Stores +
    // Plugin-Toggle-Cache. Anti-Drift: jeder neue Server-scoped Store
    // gehört in `multi-server-reset.ts`, nicht hier.
    resetServerScopedStores();
    // readState: vollständig clear() bei Sign-Out (storageKey wegnehmen,
    // damit nachfolgende markRead-Aufrufe vom Re-Login nicht auf den alten
    // User schreiben). Der user-gekeyte localStorage-Eintrag bleibt
    // unangetastet — beim Re-Login holt `hydrateForUser` ihn wieder.
    readState.clear();
    // Session-globale Stores, die NICHT in multi-server-reset.ts gehören
    // (User-Cache ist absichtlich Server-übergreifend gehalten, damit
    // beim Switch keine Avatar-Flackerer entstehen):
    userCache.clear();
    capabilities.clear();
    privacy.clear();
    serverAdmin.clear();
    onboardingState.reset();
    settings.resetUserScoped();
    // Sidebar-Variante-B-Snapshot: pro-Server-Community-Liste wegwerfen.
    void import('$lib/stores/serverGuilds.svelte').then((m) => m.serverGuilds.clear());
    // Decline-Flag zurücksetzen: ein "Als neues Gerät weiter" gilt nur für
    // die laufende Session — beim nächsten Login soll der User wieder den
    // Recover-Dialog bekommen können.
    void import('$lib/identity/issue-flow').then((m) => m.resetRecoveryDecline());
    // Phase 4.2: alle WS-Connections + Self-Host-Session-Tokens beenden.
    // Cloud-Tokens werden weiter oben via clearTokens() entfernt.
    gatewayPool.closeAll();
    for (const s of serversStore.servers) {
      if (!s.isCloud) sessionTokens.clear(s.id);
    }
    // Identity-Cleanup: Timer stoppen, Stores wischen
    stopProfileRefresh();
    stopCertRotation();
    void certStore.wipe();
    void keypairStore.wipe();
    void profileStatementStore.wipe();
    void goto('/login');
  }
}

export const auth = new AuthStore();
