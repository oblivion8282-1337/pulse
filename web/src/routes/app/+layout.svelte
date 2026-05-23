<script lang="ts">
  import { goto } from '$app/navigation';
  import { onMount, onDestroy } from 'svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { directMessages } from '$lib/stores/directMessages.svelte';
  import { readState } from '$lib/stores/readState.svelte';
  import { capabilities } from '$lib/stores/capabilities.svelte';
  import { gateway } from '$lib/ws/connection';
  import { initActivityHeartbeat, disposeActivityHeartbeat } from '$lib/ws/activity';
  import { viewport } from '$lib/stores/viewport.svelte';
  import { voice } from '$lib/voice/livekit.svelte';
  import VoiceControlBar from '$lib/components/VoiceControlBar.svelte';

  let { children } = $props();
  let hydrated = $state(false);

  /** Single source of truth for notification-click navigation: SW postMessage
   *  → `navigateTo` event, and Electron `pulse.notify.onClick` → same path.
   *  Kept inline (instead of in `$lib/notifications/`) because it owns the
   *  `goto` import which lives on the page side. */
  function navigateToFromNotification(channelId: string, guildId: string | null | undefined): void {
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
    void gateway.connect().catch((e) => console.error('gateway connect', e));
    await Promise.all([
      directMessages.hydrate().catch((e) => console.error('directMessages.hydrate failed', e)),
      capabilities.hydrate().catch((e) => console.error('capabilities.hydrate failed', e)),
      gateway.waitForReady().catch((e) => console.error('gateway ready', e))
    ]);
    hydrated = true;

    // Etappe 4: presence activity heartbeat. Throttled (≤1/60s) fire-and-
    // forget op that keeps the user off the idle sweeper. Wired up here
    // so it lives exactly as long as the /app session.
    initActivityHeartbeat();

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
    if ('serviceWorker' in navigator) {
      try {
        await navigator.serviceWorker.register('/service-worker.js', { scope: '/' });
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
        navigateToFromNotification(data.channel_id, data.guild_id ?? null);
      });
    }
  });

  onDestroy(() => {
    disposeActivityHeartbeat();
    gateway.disconnect();
    void import('$lib/voice/livekit.svelte').then(({ voice }) => voice.disconnect());
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
    let channelUnread = false;
    for (const list of Object.values(guilds.channelsByGuild)) {
      for (const c of list) {
        if (c.type === 0 && readState.isUnread(c.id)) {
          channelUnread = true;
          break;
        }
      }
      if (channelUnread) break;
    }
    document.title = dmUnread || channelUnread ? '● Pulse' : 'Pulse';
  });
</script>

<div class="text-text-base flex h-dvh w-screen flex-col" data-testid="app-shell">
  <!-- pt-[env(safe-area-inset-top)]: clears the iOS notch / status bar in the
       installed PWA (no-op as a browser tab). md restores the regular padding. -->
  <div class="flex flex-1 gap-0 p-0 pt-[env(safe-area-inset-top)] md:gap-3 md:p-3 md:pt-3 min-h-0">
    {#if !hydrated}
      <div class="text-text-muted flex flex-1 items-center justify-center text-sm">loading…</div>
    {:else}
      {@render children?.()}
    {/if}
  </div>
  <!-- Mobil: Voice-Controls als persistentes Dock unter der Panel-Zeile.
       Eigene Flex-Zeile → der Drawer (absolute in der Panel-Zeile) kann sie
       nicht überdecken; Auflegen ist immer erreichbar. Desktop: Controls
       leben im Sidebar-Footer (s. SidebarFooter). -->
  {#if viewport.isMobile && (voice.connected || voice.connecting)}
    <div class="shrink-0 pb-[env(safe-area-inset-bottom)]">
      <VoiceControlBar />
    </div>
  {/if}
</div>
