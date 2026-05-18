<script lang="ts">
  import { onMount } from 'svelte';
  import { settings } from '$lib/stores/settings.svelte';
  import {
    getPushPermissionState,
    requestPushPermission,
    unsubscribeUser,
    hasActiveSubscription
  } from '$lib/notifications/pushSubscribe';
  import { listSubscriptions, type SubscriptionDescriptor } from '$lib/notifications/api';
  import { ApiError } from '$lib/api/client';
  import { isElectron } from '$lib/platform/runtime';

  // UI state.
  let permission = $state<'granted' | 'denied' | 'default' | 'unsupported'>('default');
  let serverDisabled = $state(false);
  let busy = $state(false);
  let subs = $state<SubscriptionDescriptor[]>([]);
  let activeOnThisDevice = $state(false);
  let error = $state<string | null>(null);

  // Track whether we're on Electron — push uses native IPC there, the
  // browser-push toggle is hidden.
  const electron = isElectron();

  async function refreshState() {
    permission = getPushPermissionState();
    activeOnThisDevice = await hasActiveSubscription();
    try {
      subs = await listSubscriptions();
      serverDisabled = false;
    } catch (e) {
      if (e instanceof ApiError && e.status === 503) {
        serverDisabled = true;
        subs = [];
      } else {
        // Network or 404 (route not yet deployed) — leave list empty but
        // don't surface the "server disabled" hint.
        subs = [];
      }
    }
  }

  onMount(() => {
    void refreshState();
  });

  async function togglePush(target: boolean) {
    if (busy) return;
    busy = true;
    error = null;
    try {
      if (target) {
        const res = await requestPushPermission();
        if (res === 'granted') {
          settings.setBrowserPushEnabled(true);
        } else {
          settings.setBrowserPushEnabled(false);
          if (res === 'denied') {
            error = 'Browser-Permission wurde abgelehnt. Aktiviere Benachrichtigungen in den Browser-Einstellungen, dann erneut versuchen.';
          } else if (res === 'unsupported') {
            error = 'Dieser Browser unterstützt keine Web-Push-Notifications.';
          }
        }
      } else {
        await unsubscribeUser();
        settings.setBrowserPushEnabled(false);
      }
    } catch (e) {
      settings.setBrowserPushEnabled(false);
      if (e instanceof Error && e.message === 'push_disabled') {
        serverDisabled = true;
      } else {
        error = e instanceof Error ? e.message : 'Unbekannter Fehler.';
      }
    } finally {
      busy = false;
      await refreshState();
    }
  }

  function pushToggle() {
    void togglePush(!settings.notifications.browserPushEnabled);
  }
</script>

<div class="flex flex-col gap-5" data-testid="settings-notifications-panel">
  <div class="flex flex-col gap-1">
    <h2 class="text-text-bright text-lg font-semibold">Benachrichtigungen</h2>
    <p class="text-text-muted text-sm">
      Wann und wie Pulse dich informiert. Push-Notifications funktionieren auch, wenn
      Pulse nicht im Vordergrund läuft.
    </p>
  </div>

  {#if !electron}
    <section class="flex flex-col gap-2 rounded-2xl border border-border bg-bg-input/40 p-4">
      <div class="flex items-start justify-between gap-3">
        <div class="flex flex-col gap-1">
          <span class="text-text-bright text-sm font-medium">Browser-Push aktivieren</span>
          <span class="text-text-muted text-xs">
            Sende mir Push-Notifications auch wenn dieser Tab geschlossen ist.
          </span>
        </div>
        <button
          type="button"
          onclick={pushToggle}
          disabled={busy || permission === 'unsupported' || serverDisabled}
          aria-pressed={settings.notifications.browserPushEnabled}
          class="shrink-0 rounded-full px-3 py-1.5 text-xs font-medium transition-colors {settings
            .notifications.browserPushEnabled
            ? 'accent-gradient text-white'
            : 'bg-bg-hover text-text-bright hover:bg-bg-input'} disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="notifications-push-toggle"
        >
          {busy ? '…' : settings.notifications.browserPushEnabled ? 'Aktiv' : 'Aktivieren'}
        </button>
      </div>

      {#if serverDisabled}
        <p class="text-text-muted bg-bg-input/60 rounded-lg px-3 py-2 text-xs">
          Push ist auf diesem Server nicht konfiguriert.
        </p>
      {:else if permission === 'unsupported'}
        <p class="text-text-muted text-xs">Dein Browser unterstützt keine Web-Push-Notifications.</p>
      {:else if permission === 'denied'}
        <p class="text-text-muted text-xs">
          Browser-Permission ist abgelehnt. Aktiviere Notifications in den Browser-Einstellungen.
        </p>
      {/if}

      {#if error}
        <p class="text-destructive text-xs">{error}</p>
      {/if}

      {#if settings.notifications.browserPushEnabled && subs.length > 0}
        <p class="text-text-muted text-xs">
          Aktiv auf <span class="text-text-bright font-medium">{subs.length}</span>
          Gerät{subs.length === 1 ? '' : 'en'}
          {#if activeOnThisDevice}
            (inkl. dieses){:else}
            (nicht auf diesem Gerät){/if}.
        </p>
      {/if}
    </section>
  {:else}
    <section class="flex flex-col gap-1 rounded-2xl border border-border bg-bg-input/40 p-4">
      <span class="text-text-bright text-sm font-medium">Desktop-Notifications</span>
      <span class="text-text-muted text-xs">
        Pulse zeigt native Benachrichtigungen über das Betriebssystem — keine Browser-Permission nötig.
      </span>
    </section>
  {/if}

  <section class="flex flex-col gap-3 rounded-2xl border border-border bg-bg-input/40 p-4">
    <span class="text-text-bright text-sm font-medium">Wofür benachrichtigen</span>

    <label class="flex items-center justify-between gap-3 text-sm">
      <span class="flex flex-col">
        <span class="text-text-bright">Bei Mentions</span>
        <span class="text-text-muted text-xs">@dich, @everyone oder eine deiner Rollen.</span>
      </span>
      <input
        type="checkbox"
        class="size-4 accent-[var(--brand)]"
        checked={settings.notifications.onMention}
        onchange={(e) => settings.setNotifyOnMention((e.currentTarget as HTMLInputElement).checked)}
        data-testid="notifications-on-mention"
      />
    </label>

    <label class="flex items-center justify-between gap-3 text-sm">
      <span class="flex flex-col">
        <span class="text-text-bright">Bei Direktnachrichten</span>
        <span class="text-text-muted text-xs">Jede neue DM-Nachricht.</span>
      </span>
      <input
        type="checkbox"
        class="size-4 accent-[var(--brand)]"
        checked={settings.notifications.onDM}
        onchange={(e) => settings.setNotifyOnDM((e.currentTarget as HTMLInputElement).checked)}
        data-testid="notifications-on-dm"
      />
    </label>

  </section>
</div>
