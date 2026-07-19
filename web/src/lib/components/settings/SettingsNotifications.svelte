<script lang="ts">
  import { onMount } from 'svelte';
  import { m } from '$lib/paraglide/messages.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import FieldError from '$lib/components/feedback/FieldError.svelte';
  import { settings } from '$lib/stores/settings.svelte';
  import {
    getPushPermissionState,
    requestPushPermission,
    unsubscribeUser,
    hasActiveSubscription,
    getNotificationPermissionState,
    requestNotificationPermission
  } from '$lib/notifications/pushSubscribe';
  import { listSubscriptions, type SubscriptionDescriptor } from '$lib/notifications/api';
  import { ApiError } from '$lib/api/client';
  import { isElectron } from '$lib/platform/runtime';
  import Checkbox from '$lib/components/form/Checkbox.svelte';

  // UI state.
  let permission = $state<'granted' | 'denied' | 'default' | 'unsupported'>('default');
  let serverDisabled = $state(false);
  let busy = $state(false);
  let subs = $state<SubscriptionDescriptor[]>([]);
  let activeOnThisDevice = $state(false);
  let error = $state<string | null>(null);

  // OS-notification permission for the in-page (WS-driven) path. Independent
  // of web-push: even without server push, mention/DM/friend toasts need this
  // granted. Drives the "Allow notifications" prompt below the toggles.
  let notifyPermission = $state<'granted' | 'denied' | 'default' | 'unsupported'>('default');
  let notifyBusy = $state(false);

  // Track whether we're on Electron — push uses native IPC there, the
  // browser-push toggle is hidden.
  const electron = isElectron();

  async function requestNotifyPermission() {
    if (notifyBusy) return;
    notifyBusy = true;
    try {
      notifyPermission = await requestNotificationPermission();
    } finally {
      notifyBusy = false;
    }
  }

  async function refreshState() {
    permission = getPushPermissionState();
    notifyPermission = getNotificationPermissionState();
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
            error = m.settings_notifications_error_permission_denied();
          } else if (res === 'unsupported') {
            error = m.settings_notifications_error_unsupported();
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
        error = e instanceof Error ? e.message : m.settings_notifications_error_unknown();
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
    <h2 class="text-text-bright text-lg font-semibold">{m.settings_notifications_heading()}</h2>
    <p class="text-text-muted text-sm">
      {m.settings_notifications_subheading()}
    </p>
  </div>

  {#if !electron}
    <section class="flex flex-col gap-2 rounded-2xl border border-border bg-bg-input/40 p-4">
      <div class="flex items-start justify-between gap-3">
        <div class="flex flex-col gap-1">
          <span class="text-text-bright text-sm font-medium">{m.settings_notifications_browser_push_title()}</span>
          <span class="text-text-muted text-xs">
            {m.settings_notifications_browser_push_desc()}
          </span>
        </div>
        <button
          type="button"
          onclick={pushToggle}
          disabled={busy || permission === 'unsupported' || serverDisabled}
          aria-pressed={settings.notifications.browserPushEnabled}
          class="shrink-0 rounded-full px-3 py-2 text-xs font-medium transition-colors md:py-1.5 {settings
            .notifications.browserPushEnabled
            ? 'accent-gradient text-white'
            : 'bg-bg-hover text-text-bright hover:bg-bg-input'} disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="notifications-push-toggle"
        >
          {busy ? '…' : settings.notifications.browserPushEnabled ? m.settings_notifications_push_active() : m.settings_notifications_push_enable()}
        </button>
      </div>

      {#if serverDisabled}
        <p class="text-text-muted bg-bg-input/60 rounded-md px-3 py-2 text-xs">
          {m.settings_notifications_server_disabled()}
        </p>
      {:else if permission === 'unsupported'}
        <p class="text-text-muted text-xs">{m.settings_notifications_browser_unsupported()}</p>
      {:else if permission === 'denied'}
        <p class="text-text-muted text-xs">
          {m.settings_notifications_permission_denied()}
        </p>
      {/if}

      <FieldError message={error} />

      {#if settings.notifications.browserPushEnabled && subs.length > 0}
        <p class="text-text-muted text-xs">
          {subs.length === 1
            ? m.settings_notifications_active_devices_singular({ count: subs.length })
            : m.settings_notifications_active_devices_plural({ count: subs.length })}
          {#if activeOnThisDevice}
            {m.settings_notifications_incl_this_device()}{:else}
            {m.settings_notifications_not_this_device()}{/if}.
        </p>
      {/if}
    </section>
  {/if}

  <section class="flex flex-col gap-3 rounded-2xl border border-border bg-bg-input/40 p-4">
    <span class="text-text-bright text-sm font-medium">{m.settings_notifications_notify_for_heading()}</span>

    <label class="flex items-center justify-between gap-3 text-sm">
      <span class="flex flex-col">
        <span class="text-text-bright">{m.settings_notifications_on_mention_label()}</span>
        <span class="text-text-muted text-xs">{m.settings_notifications_on_mention_desc()}</span>
      </span>
      <Checkbox
        checked={settings.notifications.onMention}
        onchange={(e) => settings.setNotifyOnMention((e.currentTarget as HTMLInputElement).checked)}
        data-testid="notifications-on-mention"
      />
    </label>

    <label class="flex items-center justify-between gap-3 text-sm">
      <span class="flex flex-col">
        <span class="text-text-bright">{m.settings_notifications_on_dm_label()}</span>
        <span class="text-text-muted text-xs">{m.settings_notifications_on_dm_desc()}</span>
      </span>
      <Checkbox
        checked={settings.notifications.onDM}
        onchange={(e) => settings.setNotifyOnDM((e.currentTarget as HTMLInputElement).checked)}
        data-testid="notifications-on-dm"
      />
    </label>

    <label class="flex items-center justify-between gap-3 text-sm">
      <span class="flex flex-col">
        <span class="text-text-bright">{m.settings_notifications_on_friend_requests_label()}</span>
        <span class="text-text-muted text-xs">{m.settings_notifications_on_friend_requests_desc()}</span>
      </span>
      <Checkbox
        checked={settings.notifications.onFriendRequests}
        onchange={(e) => settings.setNotifyOnFriendRequests((e.currentTarget as HTMLInputElement).checked)}
        data-testid="notifications-on-friend-requests"
      />
    </label>

    {#if !electron && notifyPermission === 'default'}
      <!-- The toggles above only fire OS popups once the browser permission is
           granted. Independent of web-push — this just unlocks the in-page
           (WS-driven) path. Shown only when not yet decided. -->
      <div class="mt-1 flex items-center justify-between gap-3 rounded-md bg-bg-input/60 px-3 py-2 text-sm">
        <span class="text-text-muted text-xs">{m.settings_notifications_permission_prompt()}</span>
        <Button
          size="xs"
          onclick={requestNotifyPermission}
          disabled={notifyBusy}
          class="shrink-0"
          data-testid="notifications-permission-request"
        >
          {notifyBusy ? '…' : m.settings_notifications_permission_allow()}
        </Button>
      </div>
    {:else if !electron && notifyPermission === 'denied'}
      <p class="text-text-muted text-xs">{m.settings_notifications_permission_blocked()}</p>
    {/if}
  </section>
</div>
