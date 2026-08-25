<script lang="ts">
  import { goto } from '$app/navigation';
  import { dev } from '$app/environment';
  import { onMount, onDestroy } from 'svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { serverGuilds } from '$lib/stores/serverGuilds.svelte';
  import { serverCapabilities } from '$lib/stores/serverCapabilities.svelte';
  import { serversStore } from '$lib/api/servers.svelte';
  import { sweepDeletedServers } from '$lib/api/deleted-instance-sweep';
  import { activeServer } from '$lib/stores/active-server.svelte';
  import { directMessages } from '$lib/stores/directMessages.svelte';
  import { readState } from '$lib/stores/readState.svelte';
  import { capabilities } from '$lib/stores/capabilities.svelte';
  import { gateway } from '$lib/ws/connection';
  import { watchFehlerWacht } from '$lib/watch/fehlerwacht.svelte';
  import { gatewayPool } from '$lib/ws/gateway-pool.svelte';
  import { initActivityHeartbeat, disposeActivityHeartbeat } from '$lib/ws/activity';
  import { pendingInstanceApps } from '$lib/stores/pendingInstanceApps.svelte';
  import { pendingComplaints } from '$lib/stores/pendingComplaints.svelte';
  import { myInstanceApplications } from '$lib/stores/myInstanceApplications.svelte';
  import { myAppHostApplications } from '$lib/stores/myAppHostApplications.svelte';
  import { viewport } from '$lib/stores/viewport.svelte';
  import { voice, resumeVoiceIfPending } from '$lib/voice/livekit.svelte';
  import { autoConnectIfConfigured } from '$lib/voice/autoconnect.svelte';
  import VoiceControlBar from '$lib/components/VoiceControlBar.svelte';
  import WatchPartyPickerDialog from '$lib/components/WatchPartyPickerDialog.svelte';
  import StreamPickerDialog from '$lib/components/StreamPickerDialog.svelte';
  import RemoteConsentDialog from '$lib/remote/components/RemoteConsentDialog.svelte';
  import RemoteHostBanner from '$lib/remote/components/RemoteHostBanner.svelte';
  import RemoteErrorToast from '$lib/remote/components/RemoteErrorToast.svelte';
  import RemoteControllerInput from '$lib/remote/components/RemoteControllerInput.svelte';
  import RemoteStandplatzBanner from '$lib/remote/components/RemoteStandplatzBanner.svelte';
  import DeviceSichtschutz from '$lib/devices/components/DeviceSichtschutz.svelte';
  import DeviceKiosk from '$lib/devices/components/DeviceKiosk.svelte';
  import { standplatz } from '$lib/remote/standplatz.svelte';
  import { remoteProtokoll } from '$lib/remote/protokoll.svelte';
  import { geraeteAnmeldung } from '$lib/devices/anmeldung.svelte';
  import { standplatzProfil } from '$lib/devices/profil.svelte';
  import { loadAll } from '$lib/stream/persistence';
  import HqStreamKeepAlive from '$lib/stream/components/HqStreamKeepAlive.svelte';
  import HqStreamBackgroundHost from '$lib/stream/components/HqStreamBackgroundHost.svelte';
  import LiveKitBackgroundHost from '$lib/stream/components/LiveKitBackgroundHost.svelte';
  import WatchBackgroundHost from '$lib/watch/WatchBackgroundHost.svelte';
  import MobileTabBar from '$lib/components/mobile/MobileTabBar.svelte';
  import TabletNavRail from '$lib/components/mobile/TabletNavRail.svelte';
  import { istDetailScreen } from '$lib/navigation/tabs';
  import { openedTiles } from '$lib/stream/openedTiles.svelte';
  import { orientierungSperren } from '$lib/platform/orientation';
  import { page } from '$app/state';
  import UpdateBanner from '$lib/components/server/UpdateBanner.svelte';
  import SelfHostDisclaimer from '$lib/components/server/SelfHostDisclaimer.svelte';

  let { children } = $props();
  let hydrated = $state(false);

  // Sidebar-Variante B: aktiver Server bekommt seine Communitys vom WS-Ready-
  // Frame über ``guilds.list``. Wir spiegeln das in den ``serverGuilds``-
  // Multi-Server-Cache, damit die Sidebar-Sektion des aktiven Servers
  // dieselbe autoritative Quelle nutzt wie ChannelList / ChatView und WS-
  // Lifecycle-Events (guild_created/updated/deleted) automatisch
  // durchschlagen. ``$derived`` statt ``$effect`` — ein Derived darf
  // Side-Effects in seinem Body NICHT haben, aber wir nutzen es nur als
  // Tracking-Trigger und schreiben dann **in einem Microtask** über
  // ``queueMicrotask``, damit Svelte's Effect-Depth-Guard nicht greift.
  $effect(() => {
    const id = activeServer.serverId;
    if (!id) return;
    const list = guilds.list;
    queueMicrotask(() => {
      serverGuilds.setSnapshot(id, list);
    });
  });

  // Server-Snapshot-Loader. Läuft bei jeder Änderung von
  // serversStore.servers — neue Server (Add via AddServerDialog,
  // Cert-Login mit Invite, etc.) bekommen ihre Community-Liste sofort
  // geladen. ensureLoaded ist intern idempotent (cached Eintrag wird nicht
  // refetched), daher kein Update-Loop. queueMicrotask vermeidet den
  // Svelte-Effect-Depth-Guard, falls ensureLoaded synchron etwas
  // reaktives schreibt.
  $effect(() => {
    if (!hydrated) return;
    const serverIds = serversStore.servers.map((s) => s.id);
    const activeId = activeServer.serverId;
    queueMicrotask(() => {
      for (const id of serverIds) {
        // Capabilities für JEDEN Server (auch den aktiven) — die GuildRail
        // gatet das per-Server-„+" (Community erstellen) anhand
        // ``allow_guild_creation`` dieses Servers.
        void serverCapabilities.ensureLoaded(id);
        if (id === activeId) continue;
        void serverGuilds.ensureLoaded(id);
      }
    });
  });

  /** Single source of truth for notification-click navigation: SW postMessage
   *  → `navigateTo` event, and Electron `pulse.notify.onClick` → same path.
   *  Kept inline (instead of in `$lib/notifications/`) because it owns the
   *  `goto` import which lives on the page side. */
  function navigateToFromNotification(
    channelId: string,
    guildId: string | null | undefined,
    targetUrl?: string | null
  ): void {
    // Friend events carry an explicit in-app target (/app/friends); chat
    // events build the channel URL from the ids.
    if (targetUrl) {
      void goto(targetUrl);
      return;
    }
    if (!channelId) return;
    const url = guildId
      ? `/app/guilds/${guildId}/channels/${channelId}`
      : `/app/@me/${channelId}`;
    void goto(url);
  }

  /** Listener cleanup handles for the click bridges. Both are registered in
   *  onMount; both are torn down in onDestroy so navigation back to /login
   *  doesn't keep redirecting back into /app. */
  let _swMessageHandler: ((ev: MessageEvent) => void) | null = null;
  let _notifyUnsubscribe: (() => void) | null = null;

  onMount(async () => {
    viewport.init();
    await auth.hydrate();
    if (!auth.isAuthenticated) {
      await goto('/login', { replaceState: true });
      return;
    }
    // Hard email-verification gate: an unverified account on an SMTP-enabled
    // deployment cannot enter /app at all — chat-gateway/voice would 403 it
    // anyway. Bounce to the lock screen before connecting anything.
    if (auth.user?.email_verification_pending) {
      await goto('/verify-email-required', { replaceState: true });
      return;
    }
    // No `guilds.hydrate()` here: the WS Ready frame is authoritative for
    // the guild list (includes icon_url + created_at since Phase 4 perf
    // pass) and `gateway.connect()` already runs in parallel below. Calling
    // `GET /guilds` here used to double-fetch the same data and burn an
    // extra round-trip on the cold-boot path. We additionally await
    // `gateway.waitForReady()` so the layout doesn't paint with an empty
    // GuildRail between WS-open and Ready-arrival.
    // Dauerfreigabe + Protokoll des Standplatz-Geräts lesen, BEVOR die
    // Verbindung steht: eine Fernsteuer-Anfrage kann sofort nach dem Ready
    // hereinkommen, und `standplatz.darfOhneRueckfrage()` antwortet vor dem
    // Laden fail-closed mit „nein" (`$lib/remote/standplatz.svelte.ts`). Hier
    // gewartet statt nebenherlaufen gelassen: es ist ein Griff in einen schon
    // geladenen Speicher und kostet nichts, und die Reihenfolge ist der ganze
    // Zweck. Zugleich verfällt hier „bis Neustart" — dieser Aufruf IST der
    // Neustart.
    // EIN Griff in den Geräte-Speicher für alle drei: unter Electron ist jeder
    // ein IPC-Umlauf über die ganze Datei.
    const geraeteSpeicher = await loadAll();
    await Promise.all([
      standplatz.laden(geraeteSpeicher),
      remoteProtokoll.laden(geraeteSpeicher),
      geraeteAnmeldung.laden(geraeteSpeicher),
      standplatzProfil.laden(geraeteSpeicher),
    ]);
    // Eintragungen von Servern raeumen, die es hier nicht mehr gibt. Ein
    // entfernter Self-Host baut nie wieder eine Verbindung auf, seine
    // Eintragung wuerde also von keinem `ready` mehr beruehrt — sie haelt aber
    // weiter den Standplatz-Betrieb am Leben (`DeviceKiosk` fragt nur, OB es
    // Eintragungen gibt) und damit den Bildschirm dieses Rechners wach.
    // Nach dem Laden, weil erst dann beide Listen vorliegen.
    void geraeteAnmeldung.abgleichenMitServern(serversStore.servers.map((s) => s.id));
    void gateway.connect().catch((e) => console.error('gateway connect', e));
    // Global-Friends Stufe 1: die Cloud-Connection ist die globale Social-Quelle
    // (Freunde/DMs/Requests/Blocks/Freund-Presence) und muss dauerhaft connected
    // sein — auch wenn der restaurierte aktive Server ein Self-Host ist. connect()
    // ist idempotent: ist Cloud==aktiv, no-op (die obige connect() läuft schon).
    const cloudId = serversStore.cloudId();
    let cloudConn: { waitForReady: () => Promise<void> } | null = null;
    if (cloudId && cloudId !== activeServer.serverId) {
      try {
        const c = gatewayPool.for(cloudId);
        cloudConn = c;
        void c.connect().catch((e) => console.error('cloud gateway connect', e));
      } catch (e) {
        console.error('cloud gateway pool', e);
      }
    }
    await Promise.all([
      directMessages.hydrate().catch((e) => console.error('directMessages.hydrate failed', e)),
      capabilities.hydrate().catch((e) => console.error('capabilities.hydrate failed', e)),
      gateway.waitForReady().catch((e) => console.error('gateway ready', e)),
      // Auf den Cloud-ready warten, damit die Social-Stores vor dem ersten Paint
      // geseedet sind (sonst flackert die Freundesliste leer). Nur wenn Cloud
      // ≠ aktiv — sonst deckt `gateway.waitForReady()` es bereits ab.
      cloudConn
        ? cloudConn.waitForReady().catch((e) => console.error('cloud gateway ready', e))
        : Promise.resolve()
    ]);
    hydrated = true;

    // Voice-Resume: war der User vor einem Reload (manuelles F5 oder „Neu
    // laden" nach einem Update) in einem Voice-Channel, jetzt — nach Auth +
    // WS-Ready — automatisch zurückverbinden. Fire-and-forget; no-op, wenn
    // kein Resume-Eintrag vorliegt. DANACH (sequenziell — Resume gewinnt):
    // Auto-Connect in den fest gewählten Voice-Channel, falls konfiguriert.
    void resumeVoiceIfPending().then(() => autoConnectIfConfigured());

    // Vom Betreiber gelöschte Self-Host-Server aus der lokalen Liste räumen
    // (öffentliche Suspend-Liste der Cloud, anonymer Abgleich). Fire-and-forget.
    void sweepDeletedServers();

    // Etappe 4: presence activity heartbeat. Throttled (≤1/60s) fire-and-
    // forget op that keeps the user off the idle sweeper. Wired up here
    // so it lives exactly as long as the /app session.
    initActivityHeartbeat();

    // Cloud-Admin-Benachrichtigung: pollt offene Self-Host-Anträge (Badge im
    // UserFooter + Toast bei Zuwachs). Interner Guard pollt nur für Admins.
    pendingInstanceApps.start();
    // Dasselbe für offene Betreiber-Beschwerden (gelbe Badge im UserFooter).
    pendingComplaints.start();
    // Owner-Benachrichtigung: toastet, wenn ein eigener Antrag genehmigt/
    // abgelehnt wird. Interner Guard pollt nur bei offenem eigenen Antrag.
    myInstanceApplications.start();
    // Dasselbe für App-Hosting-Anträge — app-weit, nicht erst wenn die
    // Hosting-Karte gemountet ist: sonst gäbe es keinen roten Punkt, der den
    // frisch freigeschalteten User überhaupt erst dorthin führt.
    myAppHostApplications.start();

    // Channel-prefetch: now that Ready has populated guilds.byId, kick off
    // a `listChannels` for every guild in the background. Fire-and-forget
    // — the user can navigate the moment the layout paints, and whichever
    // guild they click hits a warm cache. `ensureChannels` dedupes against
    // a concurrent click-driven load, so we don't double-fetch if the user
    // is faster than the prefetch.
    for (const g of guilds.list) {
      void guilds.ensureChannels(g.id).catch(() => undefined);
    }

    // Service-worker registration is best-effort: SvelteKit emits
    // `/service-worker.js` from `web/src/service-worker.ts` at build time
    // (see Vite-Plugin output). We register it ourselves rather than relying
    // on auto-register so the browser-push toggle has something to call
    // `pushManager.subscribe()` on. Skipped in dev unless Vite produced one.
    //
    // `type` matters: in dev SvelteKit/Vite serves the worker as an ES module
    // (it does `import { build, files, version } from '$service-worker'`), so
    // it MUST be registered as `module` — a classic registration throws
    // "Cannot use import statement outside a module". The prod build bundles
    // it into a single classic script, so `classic` is correct there.
    if ('serviceWorker' in navigator) {
      try {
        await navigator.serviceWorker.register('/service-worker.js', {
          scope: '/',
          type: dev ? 'module' : 'classic'
        });
      } catch {
        // Dev sessions / Electron without SW — fine, push falls back to no-op.
      }
      _swMessageHandler = (ev: MessageEvent) => {
        const data = ev.data as { type?: string; channel_id?: string; guild_id?: string | null };
        if (data?.type === 'navigateTo' && data.channel_id) {
          navigateToFromNotification(data.channel_id, data.guild_id ?? null);
        }
      };
      navigator.serviceWorker.addEventListener('message', _swMessageHandler);
    }

    // Electron path: bridge `pulse.notify.onClick` to the same router. Safe
    // to call even on bundles where `notify` is missing (optional-chained).
    const notifyApi = typeof window !== 'undefined' ? window.pulse?.notify : undefined;
    if (notifyApi) {
      _notifyUnsubscribe = notifyApi.onClick((data) => {
        navigateToFromNotification(data.channel_id, data.guild_id ?? null, data.target_url ?? null);
      });
    }
  });

  onDestroy(() => {
    disposeActivityHeartbeat();
    pendingInstanceApps.stop();
    pendingComplaints.stop();
    myInstanceApplications.stop();
    gateway.disconnect();
    voice.disconnect();
    if (typeof document !== 'undefined') document.title = 'Pulse';
    if (_swMessageHandler && typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
      navigator.serviceWorker.removeEventListener('message', _swMessageHandler);
      _swMessageHandler = null;
    }
    if (_notifyUnsubscribe) {
      _notifyUnsubscribe();
      _notifyUnsubscribe = null;
    }
  });

  // Prefix the tab title with a dot when any DM or guild text channel has
  // unread activity. Visible in the browser tab bar even when Pulse is in
  // the background — cheap "you have new stuff" indicator that doesn't
  // need notification permission. Reactive: flips back when read.
  $effect(() => {
    if (typeof document === 'undefined') return;
    const dmUnread = directMessages.list.some((dm) => readState.isUnread(dm.id));
    const channelUnread = Object.values(guilds.channelsByGuild)
      .flat()
      .some((c) => c.type === 0 && readState.isUnread(c.id));
    document.title = dmUnread || channelUnread ? '● Pulse' : 'Pulse';
  });

  // Die eine Regel, die entscheidet, wer auf welcher Bildschirmgroesse
  // navigiert. Steht bewusst NUR hier: die Leisten rendern sich nicht selbst
  // weg, sonst gaebe es zwei Stellen mit derselben Bedingung.
  //
  //   < md   : Bereichs-Leiste unten, ausser auf einem Detail-Bildschirm
  //   md-lg  : Bereichs-Spalte links
  //   >= lg  : keines von beidem — das Drei-Spalten-Layout bleibt unberuehrt
  //
  // Auf einem Detail-Bildschirm (offenes Gespraech, Kanal, Einstellungsseite)
  // verschwindet die Leiste, damit der Bildschirm dem Inhalt gehoert; zurueck
  // fuehrt der Pfeil oder die System-Geste.
  //
  // AUSNAHME Sprach-/Stream-Kanal: der ist laufender Zustand, nicht ein
  // Durchgangs-Bildschirm — die Leiste bleibt (2026-08-25, Nutzerwunsch), der
  // Stream füllt die Fläche, Teilnehmer und Controls schweben darüber.
  const KANAL_BILDSCHIRM = /^\/app\/guilds\/[^/]+\/channels\/[^/]+$/;
  // Quer-Handy MIT offenem Stream: reines Stream-Vollbild — Bereichs-Leiste
  // und Voice-Dock bleiben aus (Steuerung schwebt auf dem Bild). Ohne Stream
  // bleibt quer alles wie hochkant: die normale mobile Ansicht, nur breiter.
  let kanalQuerStream = $derived(
    viewport.istHandy &&
      !viewport.isMobile &&
      KANAL_BILDSCHIRM.test(page.url.pathname) &&
      voice.connected &&
      !!voice.channelId &&
      openedTiles.hasAny(voice.channelId)
  );
  let zeigeLeisteUnten = $derived(
    hydrated &&
      viewport.istHandy &&
      !kanalQuerStream &&
      (!istDetailScreen(page.url.pathname) || KANAL_BILDSCHIRM.test(page.url.pathname))
  );
  // Handy quer ist KEIN Tablet: keine linke Spalte, die mobile Navigation
  // (unten) gilt weiter.
  let zeigeSpalteLinks = $derived(hydrated && viewport.isTablet && !viewport.istHandy);

  // Android-Hülle: Querformat nur mit offenem Stream. Ein Stream in JEDEM
  // Kanal reicht (auch im Hintergrund weiterlaufende geöffnete Kacheln) —
  // wer zusieht, will kippen dürfen; sonst nicht.
  $effect(() => {
    const streamOffen =
      voice.connected && !!voice.channelId && openedTiles.hasAny(voice.channelId);
    void orientierungSperren(!streamOffen);
  });

  // Ablehnungen des Servers zur Watch-Party sichtbar machen. Einmal je
  // Fenster — Begruendung in `watch/fehlerwacht.svelte.ts`.
  watchFehlerWacht();
</script>

<!-- `w-full` statt `w-screen`: 100vw ist auf iOS Safari breiter als der
     sichtbare Bereich (Safe-Areas/Rundungen) — Inhalte wirkten abgeschnitten.
     100% des Bodys bleibt exakt in der Viewport-Breite. -->
<div class="text-text-base flex h-dvh w-full flex-col" data-testid="app-shell">
  <!-- KEIN eigener Hintergrund hier: Die App trägt den Standard-Seitengrund
       aus app.css (Body-Verlauf + zarte Blobs + Korn) — derselbe Grund wie in
       der Desktop-App. Die Login-Marine-Ebenen (Verlauf + Glows) waren hier
       zwischenzeitlich für md+ eingebaut, fielen auf dem Tablet aber aus dem
       Rahmen; sie leben nur noch auf der Login-Seite selbst. -->

  <!-- Phase 4.3: UpdateBanner + SelfHostDisclaimer sitzen ÜBER der Panel-
       Zeile damit sie nicht von der Voice-ControlBar verdeckt werden. -->
  {#if hydrated}
    <UpdateBanner />
    <SelfHostDisclaimer />
  {/if}
  <!-- pt-[var(--safe-top)]: clears the iOS notch / status bar in the installed
       PWA and the Android APK (no-op as a browser tab). md restores the
       regular padding. -->
  <div class="flex flex-1 gap-0 p-0 pt-[var(--safe-top)] md:gap-3 md:p-3 md:pt-3 min-h-0">
    {#if zeigeSpalteLinks}
      <TabletNavRail />
    {/if}
    {#if !hydrated}
      <div class="text-text-muted flex flex-1 items-center justify-center text-sm">loading…</div>
    {:else}
      <!-- Server-Picker ist in die GuildRail unten integriert (s. dort). -->
      {@render children?.()}
    {/if}
  </div>
  <!-- Mobil: Voice-Controls als persistentes Dock unter der Panel-Zeile.
       Eigene Flex-Zeile → der Drawer (absolute in der Panel-Zeile) kann sie
       nicht überdecken; Auflegen ist immer erreichbar. Desktop: Controls
       leben im Sidebar-Footer (s. SidebarFooter). -->
  {#if viewport.istHandy && !kanalQuerStream && (voice.connected || voice.connecting)}
    <!-- `mb-2`, wenn die Bereichs-Leiste darunter steht: Abstand statt
         Kleben — das Dock sitzt damit spürbar über der Navigation. -->
    <div class="shrink-0 {zeigeLeisteUnten ? 'mb-2' : 'pb-[var(--safe-bottom)]'}">
      <VoiceControlBar />
    </div>
  {/if}
  <!-- Die Bereichs-Leiste sitzt UNTER dem Voice-Dock (Canvas 3a): das Dock ist
       der laufende Zustand, die Leiste die Navigation. `--safe-bottom` traegt
       jetzt sie, sonst laege der Home-Balken des Telefons darauf. -->
  {#if zeigeLeisteUnten}
    <div class="shrink-0 pb-[var(--safe-bottom)]">
      <MobileTabBar />
    </div>
  {/if}
</div>

<!-- Globaler Watch-Party-Auswahl-Dialog (wenn ein User mehrere Partys hostet) -->
<WatchPartyPickerDialog />

<!-- Globaler Stream-Auswahl-Dialog (wenn ein User mehrere HQ-Streams hat und ein
     Viewer aufs LIVE-Badge klickt). Ein Stream → öffnet direkt. -->
<StreamPickerDialog />

<!-- Fernsteuerung: Consent-Dialog + Host-Banner + Fehler-Toast. Alle
     store-getrieben (remoteSession), rendern nichts, wenn keine Session.
     RemoteControllerInput ist der Antrieb der steuernden Seite (Erfassung im
     Player-Fenster an/aus, Frames auf die WebSocket) — ebenfalls ohne Markup. -->
<RemoteConsentDialog />
<RemoteHostBanner />
<RemoteStandplatzBanner />
<DeviceSichtschutz />
<DeviceKiosk />
<RemoteErrorToast />
<RemoteControllerInput />

<!-- Keeps HQ stream connections alive across navigation (audio keeps
     playing, video is back instantly on return). Renders nothing. -->
<HqStreamKeepAlive />

<!-- Renders the WhepPlayer per open HQ stream on top of its StreamGrid
     anchor (docked) or as a floating corner window (navigation away).
     The inline tile was removed from StreamGrid; this is the only mount
     point. -->
<HqStreamBackgroundHost />

<!-- Renders CameraTile + ScreenShareTile per open LiveKit video on top
     of its StreamGrid anchor (docked) or as a corner window (navigation
     away). Same mechanism as HqStreamBackgroundHost. -->
<LiveKitBackgroundHost />

<!-- Hält den Watch-Party-Player über Navigation hinweg am Leben: angedockt im
     Voice-Grid, beim Weg-Navigieren als festes Eck-Fenster (Ton+Bild laufen
     weiter, kein Neuladen). -->
<WatchBackgroundHost />
