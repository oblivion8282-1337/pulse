<!--
  Server-Admin-Zugang als eigenes Symbol unten in der GuildRail (Server-Leiste).
  Bewusst NICHT mehr im User-Menü: so sieht das Konto-Menü für Admin und
  normalen User gleich aus, und der Admin-Einstieg ist ein Klick statt zwei.
  Selbst-gegated — für Nicht-Admins rendert nichts.

  Nur das Schild-Symbol (kein Text), im Stil der runden Rail-Icons. Der Punkt
  zählt offene Admin-Sachen (Instanz-/App-Hosting-Anträge, Betreiber-
  Beschwerden). Der „mein eigener Antrag ist durch"-Punkt bleibt am Avatar
  (UserFooter) — das ist ein User-Hinweis, kein Admin-Alert.
-->
<script lang="ts">
  import { goto } from '$app/navigation';
  import * as Tooltip from '$lib/components/ui/tooltip/index.js';
  import { auth } from '$lib/stores/auth.svelte';
  import { activeServer } from '$lib/stores/active-server.svelte';
  import { serverAdmin } from '$lib/stores/serverAdmin.svelte';
  import { pendingInstanceApps } from '$lib/stores/pendingInstanceApps.svelte';
  import { pendingAppHostApplications } from '$lib/stores/pendingAppHostApplications.svelte';
  import { pendingComplaints } from '$lib/stores/pendingComplaints.svelte';
  import { viewport } from '$lib/stores/viewport.svelte';
  import { m } from '$lib/paraglide/messages.js';
  import ShieldIcon from '@lucide/svelte/icons/shield';

  // Admin ist PRO Server (vgl. routes/app/admin/+page.svelte): Cloud →
  // auth.user.is_admin (auth /me); Self-Host → der is_admin aus dem ready-Frame
  // dieses Servers (Cert-Login-User haben dort kein auth /me).
  let canAdminHere = $derived(
    activeServer.current?.isCloud
      ? (auth.user?.is_admin ?? false)
      : serverAdmin.isAdmin(activeServer.current?.id ?? '')
  );

  // Alle offenen Admin-Sachen leben nur auf der Cloud (dort die Instanz-
  // Verwaltung) und nur für Cloud-Admins. Auf einem Self-Host führt das Symbol
  // aufs lokale Panel, das davon nichts weiß → kein Punkt. In der schmalen Rail
  // reicht EIN Punkt mit der Gesamtzahl; die Aufschlüsselung sieht man im Panel.
  let alertCount = $derived(
    (activeServer.current?.isCloud ?? false) && (auth.user?.is_admin ?? false)
      ? pendingInstanceApps.count +
          pendingAppHostApplications.count +
          pendingComplaints.count
      : 0
  );
</script>

{#if canAdminHere}
  <!-- Trenner über dem Schild — dasselbe Strichbild wie zwischen Pulse-Logo
       und Server-Sektionen oben in der Rail. Steht INNERHALB des Admin-Gates,
       damit er nie über dem Avatar eines normalen Users schwebt. -->
  <div class="bg-border my-1 h-px w-8 shrink-0" aria-hidden="true"></div>
  <Tooltip.Provider delayDuration={200} disabled={viewport.isMobile}>
    <Tooltip.Root>
      <Tooltip.Trigger>
        {#snippet child({ props })}
          <div class="relative shrink-0">
            <button
              {...props}
              onclick={() => goto('/app/admin')}
              class="text-text-muted hover:bg-bg-hover hover:text-primary flex size-12 items-center justify-center rounded-xl transition-all hover:rounded-md md:size-10"
              data-testid="open-admin"
              aria-label={m.user_footer_server_admin()}
            >
              <ShieldIcon class="size-6 md:size-5" />
            </button>
            {#if alertCount > 0}
              <span
                class="bg-badge-count ring-bg-panel text-2xs absolute -right-1 -bottom-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 font-bold leading-none text-white ring-2"
                data-testid="admin-pending-badge"
                aria-label={m.instance_apps_badge_aria()}
              >{alertCount > 99 ? '99+' : alertCount}</span>
            {/if}
          </div>
        {/snippet}
      </Tooltip.Trigger>
      <Tooltip.Content side="right">{m.user_footer_server_admin()}</Tooltip.Content>
    </Tooltip.Root>
  </Tooltip.Provider>
{/if}
