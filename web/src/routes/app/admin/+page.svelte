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
  import { auth } from '$lib/stores/auth.svelte';
  import { activeServer } from '$lib/stores/active-server.svelte';
  import { serverAdmin } from '$lib/stores/serverAdmin.svelte';
  import AdminOverview from '$lib/components/admin/AdminOverview.svelte';
  import AdminAttachments from '$lib/components/admin/AdminAttachments.svelte';
  import AdminRegistration from '$lib/components/admin/AdminRegistration.svelte';
  import AdminSmtp from '$lib/components/admin/AdminSmtp.svelte';
  import AdminBackup from '$lib/components/admin/AdminBackup.svelte';
  import AdminSelfHostBackup from '$lib/components/admin/AdminSelfHostBackup.svelte';
  import AdminPermissions from '$lib/components/admin/AdminPermissions.svelte';
  import AdminStreamLimits from '$lib/components/admin/AdminStreamLimits.svelte';
  import AdminNormalStreamLimits from '$lib/components/admin/AdminNormalStreamLimits.svelte';
  import AdminPlugins from '$lib/components/admin/AdminPlugins.svelte';
  import AdminInstances from '$lib/components/admin/AdminInstances.svelte';
  import AdminUsers from '$lib/components/admin/AdminUsers.svelte';
  import AdminMembers from '$lib/components/admin/AdminMembers.svelte';
  import AdminAuditLog from '$lib/components/admin/AdminAuditLog.svelte';
  import AdminJoinControl from '$lib/components/admin/AdminJoinControl.svelte';
  import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
  import { m } from '$lib/paraglide/messages.js';

  // Self-Host-Instanzen verwalten (Anträge genehmigen/sperren) ist eine reine
  // Cloud-Funktion — nur howispulse.com entscheidet, wer self-hosten darf. Auf
  // jedem Self-Host-Server blenden wir den Bereich aus (Backend riegelt zusätzlich
  // per PULSE_INSTANCE_MODE ab).
  let isCloud = $derived(activeServer.current?.isCloud ?? false);
  let serverId = $derived(activeServer.current?.id ?? '');

  // Admin ist PRO Server: Cloud → auth.user.is_admin (auth /me); Self-Host →
  // der is_admin aus dem ready-Frame dieses Servers (Cert-Login-User haben dort
  // kein auth /me). ``decided`` = haben wir für den aktiven Server überhaupt
  // schon eine Antwort? — verhindert ein Fehl-Redirect, bevor ready da ist.
  let isAdminHere = $derived(
    isCloud ? (auth.user?.is_admin ?? false) : serverAdmin.isAdmin(serverId)
  );
  let decided = $derived(isCloud ? auth.user !== null : serverAdmin.has(serverId));

  let ready = $state(false);

  $effect(() => {
    if (!auth.isAuthenticated) {
      void goto('/login', { replaceState: true });
      return;
    }
    if (!decided) return; // warte auf die Admin-Antwort des aktiven Servers
    if (!isAdminHere) {
      void goto('/app/@me', { replaceState: true });
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
          aria-label={m.admin_page_back()}
          onclick={() => goto('/app/@me')}
          data-testid="admin-back"
        >
          <ArrowLeftIcon class="size-4" />
        </button>
        <div>
          <h1 class="text-text-bright text-lg font-semibold">{m.admin_page_title()}</h1>
          <p class="text-text-muted text-xs">{m.admin_page_subtitle()}</p>
        </div>
      </div>
    </header>

    <main class="mx-auto flex w-full max-w-4xl flex-col gap-6 px-6 py-8">
      <AdminOverview {isCloud} />
      <!-- Registrierung, SMTP, Cloud-Backup-Status, Cloud-User-Verwaltung laufen
           über die auth-svc-Identity-Plane (Cloud) und sind für einen Cert-Login-
           Admin auf einer Self-Host-Instanz weder erreichbar (403) noch inhaltlich
           sinnvoll (keine lokalen auth.users, Self-Host hat eigenes pg_dump-Backup).
           Auf Self-Host ausblenden; Backup + User bekommen eigene Instanz-Varianten. -->
      {#if isCloud}
        <AdminBackup />
      {:else}
        <AdminSelfHostBackup />
      {/if}
      <AdminAttachments />
      {#if isCloud}
        <AdminRegistration />
        <AdminSmtp />
      {/if}
      <AdminPermissions />
      {#if !isCloud}
        <AdminJoinControl />
      {/if}
      <AdminStreamLimits />
      <AdminNormalStreamLimits />
      <AdminPlugins />
      {#if isCloud}
        <AdminInstances />
        <AdminUsers />
      {:else}
        <!-- Self-Host: instanzweite Member-Verwaltung statt der Cloud-User-Liste. -->
        <AdminMembers />
      {/if}
      <AdminAuditLog {isCloud} />
    </main>
  </div>
{/if}
