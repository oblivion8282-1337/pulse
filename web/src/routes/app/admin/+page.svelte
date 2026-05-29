<!--
  Server-Admin panel. Entry from UserFooter dropdown (visible only when
  `auth.user.is_admin`). The five sections each live in their own component
  under `$lib/components/admin/` so this page stays a thin layout shell.

  Double-gated: client-side this page bounces non-admins back to /app/@me
  immediately; server-side every admin endpoint also 403s — the routes
  can't be misused via curl.
-->
<script lang="ts">
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { activeServer } from '$lib/stores/active-server.svelte';
  import AdminOverview from '$lib/components/admin/AdminOverview.svelte';
  import AdminAttachments from '$lib/components/admin/AdminAttachments.svelte';
  import AdminRegistration from '$lib/components/admin/AdminRegistration.svelte';
  import AdminSmtp from '$lib/components/admin/AdminSmtp.svelte';
  import AdminBackup from '$lib/components/admin/AdminBackup.svelte';
  import AdminPermissions from '$lib/components/admin/AdminPermissions.svelte';
  import AdminPlugins from '$lib/components/admin/AdminPlugins.svelte';
  import AdminInstances from '$lib/components/admin/AdminInstances.svelte';
  import AdminUsers from '$lib/components/admin/AdminUsers.svelte';
  import AdminAuditLog from '$lib/components/admin/AdminAuditLog.svelte';
  import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';

  let ready = $state(false);

  // Self-Host-Instanzen verwalten (Anträge genehmigen/sperren) ist eine reine
  // Cloud-Funktion — nur howispulse.com entscheidet, wer self-hosten darf. Auf
  // jedem Self-Host-Server blenden wir den Bereich aus (Backend riegelt zusätzlich
  // per PULSE_INSTANCE_MODE ab).
  let isCloud = $derived(activeServer.current?.isCloud ?? false);

  onMount(async () => {
    if (!auth.isAuthenticated) {
      await goto('/login', { replaceState: true });
      return;
    }
    if (!auth.user?.is_admin) {
      await goto('/app/@me', { replaceState: true });
      return;
    }
    ready = true;
  });
</script>

{#if ready}
  <div class="flex h-dvh w-full flex-col overflow-y-auto bg-bg-panel" data-testid="admin-panel">
    <header class="sticky top-0 z-10 border-b border-border bg-bg-panel/95 px-6 py-4 backdrop-blur">
      <div class="mx-auto flex max-w-4xl items-center gap-3">
        <button
          type="button"
          class="text-text-muted hover:text-text-bright rounded-lg p-1.5 hover:bg-bg-hover"
          aria-label="Zurück"
          onclick={() => goto('/app/@me')}
          data-testid="admin-back"
        >
          <ArrowLeftIcon class="size-4" />
        </button>
        <div>
          <h1 class="text-text-bright text-lg font-semibold">Server-Admin</h1>
          <p class="text-text-muted text-xs">Globale Einstellungen für deinen Pulse-Server</p>
        </div>
      </div>
    </header>

    <main class="mx-auto flex w-full max-w-4xl flex-col gap-6 px-6 py-8">
      <AdminOverview />
      <AdminBackup />
      <AdminAttachments />
      <AdminRegistration />
      <AdminSmtp />
      <AdminPermissions />
      <AdminPlugins />
      {#if isCloud}
        <AdminInstances />
      {/if}
      <AdminUsers />
      <AdminAuditLog />
    </main>
  </div>
{/if}
