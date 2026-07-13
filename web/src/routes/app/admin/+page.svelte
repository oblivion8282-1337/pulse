<!--
  Server-Admin panel. Entry from UserFooter dropdown (visible only when
  `auth.user.is_admin`). Reiter-Schale: die Bereiche sind auf sechs Tabs
  verteilt (Übersicht · Nutzer · Anträge · Meldungen · Einstellungen ·
  Protokoll), jeder Tab-Inhalt lebt in seiner eigenen Komponente unter
  `$lib/components/admin/`. Self-Host sieht nur vier Tabs (Anträge/Meldungen
  sind reine Cloud-Funktionen).

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
  import AdminUsers from '$lib/components/admin/AdminUsers.svelte';
  import AdminMembers from '$lib/components/admin/AdminMembers.svelte';
  import AdminApplicationsTab from '$lib/components/admin/AdminApplicationsTab.svelte';
  import AdminComplaints from '$lib/components/admin/AdminComplaints.svelte';
  import AdminSettingsTab from '$lib/components/admin/AdminSettingsTab.svelte';
  import AdminAuditLog from '$lib/components/admin/AdminAuditLog.svelte';
  import { pendingAppHostApplications } from '$lib/stores/pendingAppHostApplications.svelte';
  import { adminAppHostApplicationsApi } from '$lib/api/appHostApplications';
  import { adminInstancesApi } from '$lib/api/instances';
  import { adminComplaintsApi } from '$lib/api/complaints';
  import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
  import { m } from '$lib/paraglide/messages.js';
  import { APP_HOSTING_ENABLED } from '$lib/featureFlags';

  // Self-Host-Instanzen verwalten (Anträge genehmigen/sperren) ist eine reine
  // Cloud-Funktion — nur howispulse.com entscheidet, wer self-hosten darf. Auf
  // jedem Self-Host-Server blenden wir die Bereiche aus (Backend riegelt zusätzlich
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

  type MainTab = 'overview' | 'users' | 'applications' | 'complaints' | 'settings' | 'audit';
  let activeTab = $state<MainTab>('overview');

  // Tab-Badges: warten Anträge/Meldungen? Die jeweiligen Bereiche zählen intern
  // noch einmal, aber der Tab-Badge muss den Stand auch zeigen, wenn der Tab
  // gerade NICHT offen ist — also hier auf Panel-Ebene mitzählen.
  let instancesPending = $state(0);
  let complaintsNew = $state(0);
  let applicationsBadge = $derived(instancesPending + pendingAppHostApplications.count);

  let tabs = $derived([
    { id: 'overview' as const, label: m.admin_tab_overview(), badge: 0 },
    { id: 'users' as const, label: m.admin_tab_users(), badge: 0 },
    ...(isCloud
      ? [
          { id: 'applications' as const, label: m.admin_tab_applications(), badge: applicationsBadge },
          { id: 'complaints' as const, label: m.admin_tab_complaints(), badge: complaintsNew }
        ]
      : []),
    { id: 'settings' as const, label: m.admin_tab_settings(), badge: 0 },
    { id: 'audit' as const, label: m.admin_tab_audit(), badge: 0 }
  ]);

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

  async function refreshBadges() {
    if (!isCloud || !isAdminHere) return;
    try {
      instancesPending = (await adminInstancesApi.listApplications('pending')).length;
    } catch {
      /* still — Badge bleibt einfach aus */
    }
    try {
      complaintsNew = (await adminComplaintsApi.list('new')).length;
    } catch {
      /* still */
    }
    if (APP_HOSTING_ENABLED) {
      try {
        pendingAppHostApplications.count = (
          await adminAppHostApplicationsApi.listApplications('pending')
        ).length;
      } catch {
        /* still */
      }
    }
  }

  $effect(() => {
    if (!ready || !isAdminHere) return;
    if (APP_HOSTING_ENABLED) pendingAppHostApplications.start();
    void refreshBadges();
    return () => {
      if (!ready) pendingAppHostApplications.stop();
    };
  });
</script>

{#if ready}
  <div class="bg-bg-panel flex h-dvh w-full flex-col overflow-y-auto" data-testid="admin-panel">
    <header class="border-border bg-bg-panel/95 sticky top-0 z-10 border-b px-6 py-4 backdrop-blur">
      <div class="mx-auto flex max-w-4xl flex-col gap-3">
        <div class="flex items-center gap-3">
          <button
            type="button"
            class="text-text-muted hover:text-text-bright hover:bg-bg-hover rounded-lg p-1.5"
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

        <!-- Reiter-Leiste -->
        <nav class="-mb-px flex flex-wrap gap-1" data-testid="admin-tabs">
          {#each tabs as t (t.id)}
            <button
              type="button"
              onclick={() => (activeTab = t.id)}
              class="flex items-center gap-1.5 rounded-t-lg border-b-2 px-3 py-2 text-sm transition-colors {activeTab ===
              t.id
                ? 'border-primary text-text-bright font-medium'
                : 'text-text-muted hover:text-text-base border-transparent'}"
              data-testid="admin-tab-{t.id}"
            >
              {t.label}
              {#if t.badge > 0}
                <span
                  class="inline-flex min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-semibold text-black"
                >
                  {t.badge}
                </span>
              {/if}
            </button>
          {/each}
        </nav>
      </div>
    </header>

    <main class="mx-auto flex w-full max-w-4xl flex-col gap-6 px-6 py-8">
      {#if activeTab === 'overview'}
        <AdminOverview {isCloud} />
      {:else if activeTab === 'users'}
        {#if isCloud}
          <AdminUsers />
        {:else}
          <!-- Self-Host: instanzweite Member-Verwaltung statt der Cloud-User-Liste. -->
          <AdminMembers />
        {/if}
      {:else if activeTab === 'applications' && isCloud}
        <AdminApplicationsTab onAppHostChange={refreshBadges} />
      {:else if activeTab === 'complaints' && isCloud}
        <AdminComplaints />
      {:else if activeTab === 'settings'}
        <AdminSettingsTab {isCloud} />
      {:else if activeTab === 'audit'}
        <AdminAuditLog {isCloud} />
      {/if}
    </main>
  </div>
{/if}
