import { me } from '$lib/api/auth';
import { isDefinitiveAuthError, currentAccessToken } from '$lib/api/client';
import { clearTokens, loadTokens } from '$lib/api/storage';
import { clearVoiceResume } from '$lib/voice/resume';
import { readState } from './readState.svelte';
import { userCache } from './users.svelte';
import { capabilities } from './capabilities.svelte';
import { serverAdmin } from './serverAdmin.svelte';
import { settings } from './settings.svelte';
import { hydrateServerSections } from '$lib/settings-registry';
import { privacy } from './privacy.svelte';
import { resetServerScopedStores, resetSocialStores } from './multi-server-reset';
import { goto } from '$app/navigation';
import type { User } from '$lib/api/types';
import { gatewayPool } from '$lib/ws/gateway-pool.svelte';
import { sessionTokens } from '$lib/api/session_tokens.svelte';
import { serversStore } from '$lib/api/servers.svelte';
import { profileStatementStore } from '$lib/identity/profile-statement.svelte';
import { stopProfileRefresh, startProfileRefresh } from '$lib/identity/profile-refresh.svelte';
import { activeServer } from './active-server.svelte';
// Gerätelokales Krypto-Material — es hängt an derselben Identität wie
// Keypair und Cert und muss mit ihnen verschwinden, s. die beiden Wisch-
// Stellen unten.
import { geraeteGeheimnisWischen } from '$lib/krypto/geraeteGeheimnis';
import { geraeteKennungWischen } from '$lib/krypto/geraeteKennung';
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

  /** Frisches ``/me`` ziehen, OHNE den vollen Hydrate-Pfad (der bei gesetztem
   *  ``user`` früh zurückkehrt). Für In-Session-Updates serverseitiger Flags
   *  (z.B. ``self_host_enabled`` nach App-Host-Genehmigung). Best-effort. */
  async refreshUser(): Promise<void> {
    if (!this.user) return;
    try {
      this.user = await me();
    } catch {
      /* transient — der nächste Refresh/Reload heilt */
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
        // Nach Tab-Reload/SSO-Hydrate: Cookie erneuern, Serverliste holen,
        // Profil-Auffrischung starten.
        //
        // Der Geraete-Anmelde-Fluss (runIssueFlow → Schluesselbuendel
        // veroeffentlichen) laeuft hier wieder — ohne Zertifikat (Weg A,
        // Schnittanalyse §4). Best-effort nach dem Cookie-Renew.
        void (async () => {
          // Proaktiv den 30-Min-`pulse_session`-Cookie neu etablieren, BEVOR
          // der erste Cookie-Auth-Call läuft. Nach App-Neustart/Tab-Reload ist
          // nur das JWT in localStorage da, der kurzlebige Cookie ist längst
          // abgelaufen → sonst 401 auf den ersten Cookie-Endpoint. cookieFetch
          // self-healt das zwar via 401→renew→retry, aber das rauscht bei jedem
          // Boot in die Konsole.
          try {
            await renewSession();
          } catch { /* best-effort — Fallback bleibt der 401-Retry */ }
          // Account-basierte Self-Host-Liste auch beim Session-Restore
          // nachziehen — nicht nur bei frischem Login (`setUser`). Sonst fehlt
          // der Self-Host auf jedem Gerät, das den Login wiederherstellt statt
          // sich neu anzumelden. Läuft NACH renewSession, damit der
          // Cookie-Auth-Call (/me/instances) frisch ist.
          void serversStore.hydrateFromBackend();
          startProfileRefresh();
          try {
            const { runIssueFlow } = await import('$lib/identity/issue-flow');
            await runIssueFlow();
          } catch (fehler) {
            // best-effort — der naechste Login/Restore versucht es erneut.
            // Seit B11 wirft der Fluss auch das Scheitern der Schluessel-
            // veroeffentlichung weiter; unsichtbar darf es nicht bleiben
            // (die DM-Wand bietet in App-Kontexten den sichtbaren Weg).
            console.warn('[krypto] Geraete-Anmeldung fehlgeschlagen:', fehler instanceof Error ? fehler.message : fehler);
          }
        })();
      }
    } catch (e) {
      if (isDefinitiveAuthError(e)) {
        // Der Server hat uns wirklich abgelehnt — Session tot. Tokens löschen,
        // app/+layout leitet danach auf /login um. Dieser Pfad läuft NICHT
        // über signOut() (kein Reload/anderer Tab), räumt das Web-Push-Abo
        // also separat auf — sonst bleibt es hier stehen (Bughunt
        // 2026-08-17, chat.md: dritter Abmeldeweg neben Knopf und
        // Kontowechsel). Kein Bearer-Override nötig: die Session ist schon
        // ungültig, das serverseitige DELETE scheitert ohnehin best-effort —
        // die Browser-seitige `sub.unsubscribe()` (der eigentliche Schutz
        // für den nächsten Nutzer) läuft unabhängig davon.
        void import('$lib/notifications/pushSubscribe').then((m) => m.unsubscribeUser());
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
    // Geraete-Anmeldung (Weg A) — fire-and-forget, best-effort wie beim Restore.
    void (async () => {
      try {
        const { runIssueFlow } = await import('$lib/identity/issue-flow');
        await runIssueFlow();
      } catch (fehler) {
        // s. derselbe Hinweis im Restore-Pfad oben (B11): sichtbar warnen.
        console.warn('[krypto] Geraete-Anmeldung fehlgeschlagen:', fehler instanceof Error ? fehler.message : fehler);
      }
    })();
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
   *
   * **Absichtlich NICHT dabei: der lokale Verlauf (`verlauf/schema.ts`,
   * DB `pulse-verlauf`).** Anders als die Artefakte hier ist er fuer
   * verschlüsselte Nachrichten die EINZIGE Kopie — ein Löschen bei jedem
   * Kontowechsel (auch einem versehentlichen) wäre endgültiger Datenverlust.
   * Seit dem Bughunt 2026-08-29 (Befund 1) trägt jeder Satz `kontoId`, und
   * jeder Lesepfad (`verlauf/db.ts` über `kontoFilter.ts::gehoertZuKonto`)
   * zeigt nur Sätze des GERADE angemeldeten Kontos — der Vorgänger-Bestand
   * bleibt liegen, aber unsichtbar, bis derselbe User sich wieder anmeldet.
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
      // Web-Push-Abo des Vorgängers abmelden — derselbe Grund wie in
      // signOut(): ohne das erbt der neue User am selben Gerät dessen
      // Klartext-Vorschauen von Erwähnungen/DMs. Fire-and-forget/best-effort.
      void import('$lib/notifications/pushSubscribe').then((m) => m.unsubscribeUser());
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
      // App-Host-Antrags-Beobachter + „Beigetreten"-Marker des Vorgängers —
      // konsistent zu signOut, sonst erbt der neue User die App-Host-Liste bzw.
      // ausgegraute Beitreten-Buttons.
      void import('$lib/stores/myAppHostApplications.svelte').then((mod) =>
        mod.myAppHostApplications.reset(),
      );
      void import('$lib/stores/joinedInvites.svelte').then((mod) =>
        mod.joinedInvites.clear(),
      );
      // Geräteliste des Vorgängers (Bughunt 2026-08-16): sie ist nach
      // Community gecacht und hat keinen Bezug zum Konto — der nächste Nutzer
      // am selben Fenster sähe sonst die Geräte, die der vorige sehen durfte.
      void import('$lib/devices/store.svelte').then((mod) => mod.deviceStore.reset());
      // Identitäts-Material des Vorgängers (IndexedDB) + Legacy-Stream-Keys
      // wischen — vollständig awaiten, BEVOR der nachfolgende Issue-Flow einen
      // frischen Cert für den neuen User anfordert (sonst läse er alte Keys).
      await Promise.allSettled([
        profileStatementStore.wipe(),
        // Pickle-Geheimnis und Gerätekennung gehören in dieselbe Zeile wie
        // das Keypair: solange der Pickle-Schlüssel aus dem Keypair abgeleitet
        // wurde, machte dessen Löschen den eingefrorenen Krypto-Zustand
        // unlesbar (so steht es im Kopf von `krypto/account.svelte.ts`). Seit
        // der Schlüssel aus einem eigenen Geheimnis kommt, tut das nur noch
        // dieser Aufruf — ohne ihn läse der nächste Nutzer am selben Fenster
        // den Zustand des vorigen. Die Kennung ebenso: sie käme sonst mit dem
        // neuen Cert in Widerspruch.
        geraeteGeheimnisWischen(),
        geraeteKennungWischen(),
        // Sicherungs-Wissen (DEK, Google-Token, Klartext-Puffer) gehört dem
        // vorigen Konto — ohne Wisch brächte der nächste Nutzer Archiv und
        // Schlüssel zusammen (Review 2026-08-31, Befund 2).
        import('$lib/sicherung/andock').then((m) => m.sicherungBeiAbmeldungWischen()),
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
    // Web-Push-Abo abmelden (Bughunt 2026-08-17, chat.md): sonst bleibt es
    // beim Service Worker UND beim Server (user_id, endpoint) stehen, und auf
    // einem geteilten Browserprofil laufen die Klartext-Vorschauen fremder
    // Erwähnungen/DMs auf den Bildschirm des nächsten Nutzers weiter — heilt
    // von selbst nie. Token JETZT sichern (der dynamische Import unten
    // verzögert den eigentlichen Aufruf um mind. einen Tick — clearTokens()
    // direkt danach liefe dem sonst davon) und explizit durchreichen, damit
    // das serverseitige DELETE noch autorisiert durchgeht. Fire-and-forget:
    // `unsubscribeUser()` ist best-effort (schluckt Netzwerk-/
    // Berechtigungsfehler intern), Sign-Out darf daran nicht hängen bleiben.
    // Nur für Cloud sinnvoll — `currentAccessToken()` liefert ausschließlich
    // das Cloud-JWT; ist gerade ein Self-Host aktiv, greift dessen eigener
    // Session-Token weiter automatisch über die normale Bearer-Auflösung
    // (kein Override, sonst würde ein falscher Bearer das DELETE dort kaputt
    // machen statt es zu retten).
    const pushBearer =
      (activeServer.current?.isCloud ?? true) ? (currentAccessToken() ?? undefined) : undefined;
    void import('$lib/notifications/pushSubscribe').then((m) => m.unsubscribeUser(pushBearer));
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
    // Fernsteuerung: der Store ist ein Modul-Singleton und ueberlebt den
    // Kontowechsel (die Anmeldung laeuft ohne Neuladen). Ohne das hier bekam
    // der naechste Nutzer am selben Tab eine offene Anfrage des Vorgaengers
    // vorgesetzt — Begruendung an `remoteSession.abmelden`.
    void import('$lib/remote/session.svelte').then((m) => m.remoteSession.abmelden());
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
    // App-Host-Antrags-Beobachter desselben Vorgängers (Liste + localStorage-
    // Watch-Map) — analog myInstanceApplications, sonst bleibt die App-Host-
    // Antragsliste des alten Users stehen.
    void import('$lib/stores/myAppHostApplications.svelte').then((mod) =>
      mod.myAppHostApplications.reset(),
    );
    // „Beigetreten"-Marker (gerätelokal) leeren — sonst graut die Invite-Karte
    // dem nächsten User Beitreten-Buttons für Communitys des Vorgängers aus.
    void import('$lib/stores/joinedInvites.svelte').then((mod) =>
      mod.joinedInvites.clear(),
    );
    // Geräteliste des Vorgängers — s. dieselbe Zeile im Kontowechsel oben.
    void import('$lib/devices/store.svelte').then((mod) => mod.deviceStore.reset());
    // Identity-Cleanup: Timer stoppen, Stores wischen
    stopProfileRefresh();
    void profileStatementStore.wipe();
    // Dieselbe Begründung wie im Kontowechsel-Pfad oben.
    void geraeteGeheimnisWischen();
    void geraeteKennungWischen();
    // Sicherungs-Wissen (DEK, Google-Refresh-Token, Klartext-Puffer) —
    // derselbe Grund wie im Kontowechsel-Pfad oben (Review 2026-08-31).
    void import('$lib/sicherung/andock').then((m) => m.sicherungBeiAbmeldungWischen());
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
