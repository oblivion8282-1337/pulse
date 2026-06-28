<script lang="ts">
  import '../app.css';
  import { onMount } from 'svelte';
  import { updated } from '$app/state';
  import { ModeWatcher } from 'mode-watcher';
  import { Toaster } from '$lib/components/ui/sonner/index.js';
  import { toast } from 'svelte-sonner';
  import { settings } from '$lib/stores/settings.svelte';
  import { initStream } from '$lib/stream/state.svelte';
  import { loadAll as loadPlugins } from '$lib/plugins';
  import ShortcutHost from '$lib/components/ShortcutHost.svelte';
  import ChangelogGate from '$lib/components/ChangelogGate.svelte';
  import { serversStore } from '$lib/api/servers.svelte';
  import { activeServer } from '$lib/stores/active-server.svelte';
  import { initSelfHostReauth } from '$lib/api/self-host-reauth';
  import { isElectron } from '$lib/platform/runtime';
  import {
    checkNativeUpdate,
    nativeUpdateAlreadySeen,
    markNativeUpdateSeen
  } from '$lib/platform/nativeUpdate';
  import { m } from '$lib/paraglide/messages.js';
  import { gatewayPool } from '$lib/ws/gateway-pool.svelte';
  import { initLocale } from '$lib/i18n';
  import { joinGuildByInvite } from '$lib/guilds/joinByInvite';
  import { SelfHostContactConfirmRequired, BackupRequiredError } from '$lib/api/add-server-flow';
  import SelfHostContactConfirmDialog from '$lib/components/server/SelfHostContactConfirmDialog.svelte';
  import BackupGateDialog from '$lib/components/identity/BackupGateDialog.svelte';

  // Sprache so früh wie möglich festlegen (synchron, vor dem ersten Render),
  // damit alle Texte direkt in der richtigen Sprache erscheinen — „de sonst en"
  // nach Systemsprache, manuelle Wahl (localStorage) hat Vorrang.
  initLocale();

  // Phase 4.1: Multi-Server-Store + Active-Server synchron vor allem anderen
  // initialisieren, damit Consumers immer einen fertigen State vorfinden.
  serversStore.init();
  activeServer.init(serversStore);
  // Eager-Bootstrap der WS-Handler-Registry: die Default-Handler werden im
  // GatewayConnection-Konstruktor via bootstrapHandlersOnce installiert.
  // `loadPlugins()` snapshotted die Registry vor jedem Plugin-`register()` —
  // ohne den Eager-Build würde der Snapshot leer sein und der Permission-Gate
  // alle parallel installierten Default-Handler dem Plugin als "undeclared"
  // zurechnen. `for(...)` instanziert nur das Objekt, kein dial().
  if (activeServer.serverId) {
    gatewayPool.for(activeServer.serverId);
  }
  // Phase 5.2: Self-Host Re-Auth-Hook (Cert-Login) registrieren — wirkt für
  // jeden 401/Session-Expiry-Trigger aus dem API-Client.
  initSelfHostReauth();

  let { children } = $props();

  // Erstkontakt-Bestätigung für Electron-Deeplink-Invites zu neuen, unbekannten
  // Self-Hosts (Sicherheits-Gate — siehe joinGuildByInvite / SelfHostContactConfirmRequired).
  let inviteConfirmOpen = $state(false);
  let inviteConfirmHost = $state('');
  let pendingInviteLink = $state<string | null>(null);

  /** Startet den Deeplink-Join; bei einem unbestätigten neuen Self-Host wird der
   *  Bestätigungs-Dialog geöffnet statt direkt zu kontaktieren. */
  async function runDeepLinkJoin(link: string, confirmed: boolean): Promise<void> {
    try {
      await joinGuildByInvite(link, confirmed);
    } catch (e) {
      // Bewusster Abbruch des Backup-Setups → still verwerfen.
      if (e instanceof BackupRequiredError) return;
      if (e instanceof SelfHostContactConfirmRequired) {
        inviteConfirmHost = e.hostname;
        pendingInviteLink = link;
        inviteConfirmOpen = true;
        return;
      }
      console.error('invite deep-link', e);
    }
  }

  function onConfirmInviteContact(): void {
    const link = pendingInviteLink;
    inviteConfirmOpen = false;
    pendingInviteLink = null;
    if (link) void runDeepLinkJoin(link, true);
  }

  function onCancelInviteContact(): void {
    inviteConfirmOpen = false;
    pendingInviteLink = null;
  }

  // Neue-Web-Version-Hinweis: SvelteKit pollt `_app/version.json` (Intervall in
  // svelte.config.js). Sobald die deployte Version ≠ der laufenden ist, wird
  // `updated.current` true → einmaliger persistenter Toast mit „Neu laden".
  // Greift in Browser + Electron (beide laden die Remote-App), kein Backend
  // nötig. Guard, damit der Poll den Toast nicht bei jedem Tick neu aufmacht.
  let _updateToastShown = false;
  $effect(() => {
    if (updated.current && !_updateToastShown) {
      _updateToastShown = true;
      toast('Neue Version verfügbar', {
        description: 'Lade neu für die neueste Pulse-Version.',
        duration: Infinity,
        action: {
          label: 'Neu laden',
          onClick: () => location.reload(),
        },
      });
    }
  });

  // Re-assert the persisted appearance preference (dcc.settings) as the source
  // of truth once ModeWatcher has mounted.
  onMount(() => {
    settings.applyTheme();
    // Ebene-2-Update-Hinweis (native Hülle): nur in der Electron-App und nur,
    // wenn die laufende Shell hinter der in /native.json veröffentlichten
    // Version liegt. Windows ist hier still — der electron-updater zeigt sein
    // eigenes „Update bereit"-Banner (checkNativeUpdate liefert dort null).
    // Mac (unsigniert) → DMG-Download-Link, Linux → flatpak-Nudge. Einmal pro
    // Version (localStorage), unabhängig vom Login-Status.
    void checkNativeUpdate().then((info) => {
      if (!info || nativeUpdateAlreadySeen(info.latest)) return;
      markNativeUpdateSeen(info.latest);
      if (info.action === 'download') {
        toast(m.native_update_title(), {
          description: m.native_update_download_desc(),
          duration: Infinity,
          action: {
            label: m.native_update_download_action(),
            onClick: () => {
              if (info.downloadUrl) window.open(info.downloadUrl, '_blank', 'noopener');
            }
          }
        });
      } else {
        toast(m.native_update_title(), {
          description: m.native_update_flatpak_desc(),
          duration: Infinity
        });
      }
    });
    // (Globales Desktop-PTT bewusst nicht vorhanden — es braeuchte einen nativen
    // Key-Listener für Hold-to-Talk, Aufwand/Nutzen passt nicht. Das In-Fenster-
    // PTT in VoiceChannelView, Taste aus settings.voice.pttKey, ist der aktive Pfad.)
    // Wire the GSR-sidecar event channel into the reactive stream-state store.
    // No-op outside Electron; safe to call eagerly because the sidecar itself is
    // still lazy-spawned (the first invoke is what brings Python up).
    let disposeStream: (() => void) | undefined;
    void initStream().then((d) => {
      disposeStream = d;
    });
    // Plugin-System Schritt 4: discover + activate plugins. Per-plugin
    // failures are caught inside loadAll(); this top-level guard is just
    // belt-and-suspenders so a broken plugin can never break boot.
    void loadPlugins().catch((err) => console.error('[plugins] loadAll failed', err));
    // Wire the Electron invite deep-link bridge (Phase 5.3). When main
    // receives a pulse://invite?host=...&code=... URL (validated there),
    // it sends {hostname, code} over IPC. We join via joinGuildByInvite —
    // which gates the FIRST contact with a new, unknown Self-Host behind a
    // confirmation dialog (runDeepLinkJoin handles the gate).
    let disposeInvite: (() => void) | undefined;
    if (isElectron()) {
      disposeInvite = window.pulse?.invite?.onLink((data) => {
        const fakeLink = `https://app/invite/${encodeURIComponent(data.code)}?host=${encodeURIComponent(data.hostname)}`;
        void runDeepLinkJoin(fakeLink, false);
      });
      // Pull any deep-link that arrived before this onMount listener was
      // registered (finding 156 — completes pull-based delivery).
      void window.pulse?.invite?.getPending().then((data) => {
        if (data) {
          const fakeLink = `https://app/invite/${encodeURIComponent(data.code)}?host=${encodeURIComponent(data.hostname)}`;
          void runDeepLinkJoin(fakeLink, false);
        }
      });
    }

    // Auto-Update-Banner (Windows-Desktop). Main (electron-updater) lädt das
    // Update selbst und feuert `updates:ready`, sobald es installierbereit ist.
    // Wir zeigen einen persistenten sonner-Toast mit „Neu starten"-Button
    // (quitAndInstall via main). Ignoriert der User ihn, installiert das Update
    // automatisch beim nächsten App-Beenden (autoInstallOnAppQuit). `onReady`
    // feuert außerhalb gepackter Windows-Builds nie → kein Guard nötig.
    let disposeUpdate: (() => void) | undefined;
    if (isElectron()) {
      disposeUpdate = window.pulse?.updates?.onReady((data) => {
        toast('Update bereit', {
          description: `Version ${data.version} wird installiert, sobald du neu startest.`,
          duration: Infinity,
          action: {
            label: 'Neu starten',
            onClick: () => void window.pulse?.updates?.restartNow(),
          },
        });
      });
    }

    return () => {
      disposeStream?.();
      disposeInvite?.();
      disposeUpdate?.();
    };
  });
</script>

<svelte:head>
  <title>Pulse</title>
</svelte:head>

<ModeWatcher defaultMode="system" track disableHeadScriptInjection />

<div class="min-h-dvh">
  {@render children?.()}
</div>

<ShortcutHost />

<ChangelogGate />

<SelfHostContactConfirmDialog
  open={inviteConfirmOpen}
  hostname={inviteConfirmHost}
  onConfirm={onConfirmInviteContact}
  onCancel={onCancelInviteContact}
/>

<BackupGateDialog />

<Toaster position="bottom-right" richColors />
