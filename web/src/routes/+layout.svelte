<script lang="ts">
  import '../app.css';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { ModeWatcher } from 'mode-watcher';
  import { Toaster } from '$lib/components/ui/sonner/index.js';
  import { toast } from 'svelte-sonner';
  import { settings } from '$lib/stores/settings.svelte';
  import { initDesktopPtt } from '$lib/platform/ptt';
  import { initStream } from '$lib/stream/state.svelte';
  import { loadAll as loadPlugins } from '$lib/plugins';
  import ShortcutHost from '$lib/components/ShortcutHost.svelte';
  import { serversStore } from '$lib/api/servers.svelte';
  import { activeServer } from '$lib/stores/active-server.svelte';
  import { initSelfHostReauth } from '$lib/api/self-host-reauth';
  import { isElectron } from '$lib/platform/runtime';
  import { gatewayPool } from '$lib/ws/gateway-pool.svelte';
  import { initLocale } from '$lib/i18n';

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

  // Re-assert the persisted appearance preference (dcc.settings) as the source
  // of truth once ModeWatcher has mounted.
  onMount(() => {
    settings.applyTheme();
    // Wire up the desktop global push-to-talk shortcut. Currently a no-op stub
    // (global PTT needs a native key-listener — see ptt.ts); the in-window
    // keyboard PTT in VoiceChannelView keeps working regardless.
    let disposePtt: (() => void) | undefined;
    void initDesktopPtt().then((d) => {
      disposePtt = d;
    });
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
    // it sends {hostname, code} over IPC. We navigate to the existing
    // /invite/[code] route with ?host= so the user sees a disclaimer before
    // any server contact happens.
    let disposeInvite: (() => void) | undefined;
    if (isElectron()) {
      disposeInvite = window.pulse?.invite?.onLink((data) => {
        void goto(
          `/invite/${encodeURIComponent(data.code)}?host=${encodeURIComponent(data.hostname)}`
        );
      });
      // Pull any deep-link that arrived before this onMount listener was
      // registered (finding 156 — completes pull-based delivery).
      void window.pulse?.invite?.getPending().then((data) => {
        if (data) {
          void goto(
            `/invite/${encodeURIComponent(data.code)}?host=${encodeURIComponent(data.hostname)}`
          );
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
      disposePtt?.();
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

<Toaster position="bottom-right" richColors />
