<!--
  Guild settings page. Two sections so far — Rollen + Eigentümerschaft —
  rendered top-to-bottom with anchor links instead of tabs because the
  page is short. Server-side gating is MANAGE_ROLES for the role editor
  and owner-only for the ownership section; this page just hides what
  you can't use rather than 403'ing on POST.
-->
<script lang="ts">
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { Button } from '$lib/components/ui/button/index.js';
  import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
  import { onMount } from 'svelte';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { roles } from '$lib/stores/roles.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { Perm } from '$lib/permissions/bitfield';
  import { rolesApi } from '$lib/api/roles';
  import RolesEditor from '$lib/components/settings/RolesEditor.svelte';
  import MemberRoleAssignment from '$lib/components/settings/MemberRoleAssignment.svelte';
  import OwnerTransferSection from '$lib/components/settings/OwnerTransferSection.svelte';

  let guildId = $derived(page.params.guildId ?? '');
  let guild = $derived(guilds.byId[guildId]);
  let canManageRoles = $derived(roles.hasGuildPermission(guildId, Perm.MANAGE_ROLES));
  let isOwner = $derived(!!guild && auth.user?.id === guild.owner_id);
  let myPermissions = $derived(roles.myGuildPerms[guildId] ?? '0');

  // Ensure the role list is loaded — ready seeds it when the user is
  // already a member at session start, but a freshly-joined guild
  // bypasses that path. Best-effort: a failure leaves the editor empty
  // and the user can refresh.
  onMount(() => {
    if (guildId) {
      void rolesApi
        .list(guildId)
        .then((rows) => {
          for (const r of rows) roles.upsertRole(r);
        })
        .catch(() => undefined);
    }
  });
</script>

<svelte:head>
  <title>Server-Einstellungen — Pulse</title>
</svelte:head>

<div class="bg-bg-base text-text-base min-h-screen">
  <header class="border-border bg-bg-base/95 sticky top-0 z-10 flex items-center gap-3 border-b px-4 py-3 backdrop-blur">
    <Button variant="ghost" size="icon-sm" onclick={() => goto(`/app/guilds/${guildId}/channels/_`)}>
      <ArrowLeftIcon />
    </Button>
    <h1 class="text-text-bright text-base font-semibold">
      {guild?.name ?? '…'} · Einstellungen
    </h1>
  </header>

  <main class="mx-auto max-w-4xl space-y-10 px-4 py-6">
    {#if !guild}
      <p class="text-text-muted text-sm">Server nicht gefunden.</p>
    {:else}
      {#if canManageRoles}
        <section>
          <h2 class="text-text-bright mb-3 text-base font-semibold">Rollen</h2>
          <RolesEditor {guildId} editorPermissions={myPermissions} />
        </section>
        <hr class="border-border" />
        <section>
          <h2 class="text-text-bright mb-3 text-base font-semibold">Mitglieder &amp; Rollen</h2>
          <MemberRoleAssignment {guildId} editorPermissions={myPermissions} />
        </section>
      {:else}
        <p class="text-text-muted text-sm">
          Du brauchst „Rollen verwalten" (MANAGE_ROLES), um Rollen zu editieren.
        </p>
      {/if}

      {#if isOwner}
        <hr class="border-border" />
        <OwnerTransferSection {guild} />
      {/if}
    {/if}
  </main>
</div>
