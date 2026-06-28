import { me } from '$lib/api/auth';
import { isDefinitiveAuthError } from '$lib/api/client';
import { clearTokens, loadTokens } from '$lib/api/storage';
import { clearVoiceResume } from '$lib/voice/resume';
import { readState } from './readState.svelte';
import { userCache } from './users.svelte';
import { capabilities } from './capabilities.svelte';
import { serverAdmin } from './serverAdmin.svelte';
import { serverUser } from './serverUser.svelte';
import { settings } from './settings.svelte';
import { hydrateServerSections } from '$lib/settings-registry';
import { privacy } from './privacy.svelte';
import { resetServerScopedStores, resetSocialStores } from './multi-server-reset';
import { goto } from '$app/navigation';
import type { User } from '$lib/api/types';
import { gatewayPool } from '$lib/ws/gateway-pool.svelte';
import { sessionTokens } from '$lib/api/session_tokens.svelte';
import { serversStore } from '$lib/api/servers.svelte';
import { certStore } from '$lib/identity/cert.svelte';
import { keypairStore } from '$lib/identity/keypair.svelte';
import { profileStatementStore } from '$lib/identity/profile-statement.svelte';
import { stopProfileRefresh, startProfileRefresh } from '$lib/identity/profile-refresh.svelte';
import { stopCertRotation, startCertRotation } from '$lib/identity/cert-rotation.svelte';
import { activeServer } from './active-server.svelte';
import { clearLegacyStreamCredentials } from '$lib/stream/persistence';
import { renewSession } from '$lib/api/cookie-client';

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

  /**
   * Holt `/me`, wiederholt transiente Fehler (offline, Deploy-Fenster-5xx) mit
   * Backoff. Ein definitives 401/403 wird sofort weitergeworfen (Session tot);
   * nach Ausschöpfen der Retries wird der letzte transiente Fehler geworfen,
   * sodass der Aufrufer die Tokens BEHÄLT. Verhindert, dass ein kurzer Backend-
   * Neustart (Deploy) den User ausloggt. ~17,5 s Worst-Case bevor aufgegeben
   * wird — die meisten Deploys sind in diesem Fenster wieder oben.
   */
  private async _fetchMeResilient(): Promise<User> {
    const backoffMs = [500, 1000, 2000, 4000, 5000, 5000];
    for (let attempt = 0; ; attempt++) {
      try {
        return await me();
      } catch (e) {
        if (isDefinitiveAuthError(e) || attempt >= backoffMs.length) throw e;
        await new Promise((r) => setTimeout(r, backoffMs[attempt]));
      }
    }
  }

  private async _doHydrate(): Promise<void> {
    this.loading = true;
    try {
      this.user = await this._fetchMeResilient();
      if (this.user) {
        // Account-Switch-Schutz VOR dem Tresor-Pull: meldet sich ein anderer
        // User am selben Gerät an, erst die Artefakte des Vorgängers räumen,
        // damit `pullIfUnlocked()` nicht mit dessen Schlüssel/Liste arbeitet.
        await this._enforceDeviceOwner(this.user.id);
        readState.hydrateForUser(this.user.id);
        // E2E-Server-Vault: liegt ein Key in IDB (Gerät hat Backup eingerichtet),
        // Schritt 3b: pull server-backed settings sections so plugins
        // that opted into cross-device sync see the latest state.
        // Best-effort; a network blip just leaves the local slice in
        // place, the next mutation will push it back up.
        void hydrateServerSections();
        // Fix 2: Cert + Timer nach Tab-Reload/SSO-Hydrate nachholen.
        // issue-flow wird lazy geladen (eigener Chunk, nur hier gebraucht);
        // die Timer-Helfer (start*) sind oben statisch importiert.
        // Fehler im Issue-Flow werden gracefully geschluckt — Timer starten
        // trotzdem, die Rotation-Callbacks retry'en beim nächsten Interval.
        import('$lib/identity/issue-flow')
          .then(async ({ runIssueFlow }) => {
            // Proaktiv den 30-Min-`pulse_session`-Cookie neu etablieren, BEVOR
            // der erste Cookie-Auth-Call (runIssueFlow → /credentials/issue)
            // läuft. Nach App-Neustart/Tab-Reload ist nur das JWT in
            // localStorage da, der kurzlebige Cookie ist längst abgelaufen →
            // sonst 401 auf den ersten Cookie-Endpoint. cookieFetch self-healt
            // das zwar via 401→renew→retry, aber das rauscht bei jedem Boot in
            // die Konsole. Best-effort: schlägt der Renew fehl, bleibt der
            // 401-Retry in cookieFetch die Auffanglinie.
            try {
              await renewSession();
            } catch { /* best-effort — Fallback bleibt der 401-Retry */ }
            try {
              await runIssueFlow();
            } catch {
              // Andere Fehler (Netzwerk etc.): Timer trotzdem starten. Die
              // Rotation-Callbacks wiederholen den Versuch beim nächsten Interval.
              // Kein rethrow — wir wollen immer zu startProfileRefresh/startCertRotation.
            }
            startProfileRefresh();
            startCertRotation();
          })
          .catch(() => {/* silent — degradiert gracefully */});
      }
    } catch (e) {
      if (isDefinitiveAuthError(e)) {
        // Der Server hat uns wirklich abgelehnt — Session tot. Tokens löschen,
        // app/+layout leitet danach auf /login um.
        clearTokens();
        this.user = null;
      } else {
        // Transient (offline / Deploy-5xx), auch nach den Retries noch nicht
        // erreichbar. Tokens BEHALTEN, damit der nächste Reload — oder die
        // WS-Reconnect-Schleife — die Session wiederherstellt, OHNE dass der
        // User sein Passwort neu eintippen muss. `user` bleibt für diesen Boot
        // null (app/+layout zeigt /login, aber ein Reload heilt ohne Re-Login).
        this.user = null;
      }
    } finally {
      this.loading = false;
      this._hydrateInflight = null;
    }
  }

  async setUser(user: User): Promise<void> {
    this.user = user;
    readState.hydrateForUser(user.id);
    // Account-Switch-Schutz zuerst (Login ohne Tab-Reload). Wird hier AWAITED,
    // damit ein direkt nachfolgender Issue-Flow (login/register rufen `await
    // setUser` → `runIssueFlow`) garantiert NACH den IDB-Wipes läuft und nie das
    // Keypair eines Vorgängers liest. Bei gleichem User ist der Cleanup ein
    // No-Op, sodass der reguläre Re-Login (und Patch-Updates wie Avatar/TOTP)
    // nichts verlieren.
    await this._enforceDeviceOwner(user.id);
    // Schritt-3b cross-device hydrate, ausgelöst direkt nach dem Token-Save.
    void hydrateServerSections();
    // Account-basierte Self-Host-Liste aus dem Backend mergen
    // (gegen `signOut → keepOnlyCloud(true)`-Verlust). Details im Helper.
    void serversStore.hydrateFromBackend();
  }

  /**
   * Geräte-Besitzer-Wächter (Account-Switch-Schutz). Hinterlegt pro Gerät, wem
   * es zuletzt gehörte (`pulse.identity_owner`). Meldet sich ein **anderer** User
   * am selben Rechner an, werden die kontogebundenen, gerätelokalen Artefakte des
   * Vorgängers entfernt — sonst sähe der neue User dessen Self-Host-Liste und
   * erbte dessen Identität/Tresor (der gerätelokale `pulse.servers`-Leak). Der
   * rechtmäßige Besitzer stellt alles beim nächsten eigenen Login per Master-
   * Passwort aus dem Server-Tresor wieder her.
   *
   * Läuft auf Web UND Electron identisch (Electron lädt denselben Renderer);
   * der native Stream-Store wird über `clearLegacyStreamCredentials()` defensiv
   * mit-entleert. Gleicher User → reiner No-Op (nur Owner-Tag setzen).
   */
  private async _enforceDeviceOwner(userId: string): Promise<void> {
    if (typeof window === 'undefined') return;
    const OWNER_KEY = 'pulse.identity_owner';
    let prev: string | null = null;
    try {
      prev = window.localStorage.getItem(OWNER_KEY);
    } catch {
      /* localStorage unzugänglich → Wächter degradiert still */
    }
    if (prev && prev !== userId) {
      // Self-Host-Connections + Session-Tokens des Vorgängers schließen.
      for (const s of serversStore.servers) {
        if (s.isCloud) continue;
        gatewayPool.close(s.id);
        sessionTokens.clear(s.id);
      }
      // Self-Hosts aus der Geräte-Liste entfernen (silent: kein Tresor-Push).
      serversStore.keepOnlyCloud(true);
      const cloudId = serversStore.cloudId();
      if (cloudId) activeServer.set(cloudId);
      else {
        // Defensive: ohne Cloud-Eintrag (sollte nach init() nie passieren) den
        // stale active_server-Verweis wenigstens aus localStorage räumen.
        try {
          window.localStorage.removeItem('pulse.active_server');
        } catch {
          /* ignore */
        }
      }
      // In-Memory-Reste leeren (greift im SPA-Login-Pfad ohne Reload).
      resetServerScopedStores();
      resetSocialStores();
      // Voice-Resume des Vorgängers verwerfen, damit ein anderer User am selben
      // Gerät nicht in dessen Channel auto-rejoined.
      clearVoiceResume();
      // User-gebundene UX-Marker des Vorgängers räumen (wie signOut), damit der
      // neue User Changelog/Self-Host-Disclaimer frisch bekommt und keine
      // „schon gesehen"-Flags erbt. Disclaimer-Flags sind self-host-gebunden —
      // nach dem keepOnlyCloud existiert kein Self-Host mehr, also alle wegfegen.
      try {
        for (const k of Object.keys(window.localStorage)) {
          if (k.startsWith('pulse.disclaimer_')) window.localStorage.removeItem(k);
        }
        window.localStorage.removeItem('pulse.changelog.lastSeen');
      } catch {
        /* ignore */
      }
      // Self-Host-Antrags-Beobachter zurücksetzen (Memory pendingSetup + die
      // flachen Watch-/Ack-Keys), sonst zeigt der neue User den „genehmigt"-
      // Punkt des Vorgängers — und _poll räumt eine approved Watch-Map nie.
      void import('$lib/stores/myInstanceApplications.svelte').then((mod) =>
        mod.myInstanceApplications.reset(),
      );
      // Identitäts-Material des Vorgängers (IndexedDB) + Legacy-Stream-Keys
      // wischen — vollständig awaiten, BEVOR der nachfolgende Issue-Flow einen
      // frischen Cert für den neuen User anfordert (sonst läse er alte Keys).
      await Promise.allSettled([
        certStore.wipe(),
        keypairStore.wipe(),
        profileStatementStore.wipe(),
        clearLegacyStreamCredentials(),
      ]);
    }
    try {
      window.localStorage.setItem(OWNER_KEY, userId);
    } catch {
      /* ignore */
    }
  }

  signOut(): void {
    clearTokens();
    // Voice-Resume verwerfen — nach explizitem Logout darf der nächste Boot
    // nicht in den alten Channel zurückspringen.
    clearVoiceResume();
    this.user = null;
    // Server-scoped Stores: Helper aus Phase 4.5 — leert die Guild-Realtime-
    // Stores + Plugin-Toggle-Cache. Anti-Drift: jeder neue Server-scoped Store
    // gehört in `multi-server-reset.ts`, nicht hier.
    resetServerScopedStores();
    // Global-Friends Stufe 1: die Social-Stores (Freunde/DMs/Requests/Blocks/
    // Freund-Presence) sind NICHT mehr Teil von resetServerScopedStores
    // (überleben Server-Switch bewusst) → bei Sign-Out separat leeren.
    resetSocialStores();
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
    serverUser.clear();
    settings.resetUserScoped();
    // Sidebar-Variante-B-Snapshot: pro-Server-Community-Liste wegwerfen.
    void import('$lib/stores/serverGuilds.svelte').then((m) => m.serverGuilds.clear());
    void import('$lib/stores/serverCapabilities.svelte').then((m) =>
      m.serverCapabilities.clear(),
    );
    // Phase 4.2: alle WS-Connections + Self-Host-Session-Tokens beenden.
    // Cloud-Tokens werden weiter oben via clearTokens() entfernt.
    gatewayPool.closeAll();
    for (const s of serversStore.servers) {
      if (!s.isCloud) sessionTokens.clear(s.id);
    }
    // Self-Host-Antrags-Beobachter (gerätelokaler Watch-/Ack-State + roter
    // Punkt) leeren — sonst erbt der nächste User am selben Gerät den
    // „genehmigt"-Punkt des Vorgängers (dyn. Import gegen Circular-Import).
    void import('$lib/stores/myInstanceApplications.svelte').then((mod) =>
      mod.myInstanceApplications.reset(),
    );
    // Identity-Cleanup: Timer stoppen, Stores wischen
    stopProfileRefresh();
    stopCertRotation();
    void certStore.wipe();
    void keypairStore.wipe();
    void profileStatementStore.wipe();
    // Self-Hosts (Hostnames + pairwise_subs) aus der gerätelokalen Liste
    // entfernen — konsistent zum Account-Switch-Pfad (_enforceDeviceOwner).
    // silent=true: kein Tresor-Push, der den Server-Tresor leeren würde.
    serversStore.keepOnlyCloud(true);
    const cloudId = serversStore.cloudId();
    if (cloudId) activeServer.set(cloudId);
    // Geräte-Besitzer-Tag entfernen, damit der nächste Login als frischer
    // Owner-Wechsel/Setup behandelt wird (wie _enforceDeviceOwner ihn setzt).
    try {
      window.localStorage.removeItem('pulse.identity_owner');
    } catch {
      /* ignore */
    }
    void goto('/login');
  }
}

export const auth = new AuthStore();
