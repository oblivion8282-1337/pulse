<!--
  Two toggle switches: who can create guilds, who can issue invites.

  Defaults are both ``on`` (the migration seeds them so) which keeps the
  historical "anyone can" behaviour. Off-states fall back to admin-only
  for guild creation and guild-owner-only for invites — see the server-
  side enforcement in routes/guilds.py + routes/invites.py.

  Toggles save immediately on click (no Speichern-button) since each
  switch is a single bool — the latency feels weird with a two-step
  flow. The PATCH is debounced via the in-flight check on the button.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { toast } from 'svelte-sonner';
  import { adminApi, type Permissions } from '$lib/api/admin';

  let current = $state<Permissions | null>(null);
  let busy = $state<{ allow_guild_creation: boolean; allow_member_invites: boolean }>({
    allow_guild_creation: false,
    allow_member_invites: false
  });
  let error = $state<string | null>(null);

  onMount(async () => {
    try {
      current = await adminApi.getPermissions();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  });

  async function toggle(field: keyof Permissions) {
    if (!current || busy[field]) return;
    busy[field] = true;
    const next = !current[field];
    try {
      const updated = await adminApi.patchPermissions({ [field]: next });
      current = updated;
      toast.success('Berechtigung aktualisiert');
    } catch (e) {
      toast.error('Speichern fehlgeschlagen', {
        description: e instanceof Error ? e.message : String(e)
      });
    } finally {
      busy[field] = false;
    }
  }
</script>

{#snippet toggleRow(field: keyof Permissions, title: string, description: string)}
  <div class="flex items-start justify-between gap-4 rounded-xl border border-border bg-bg-hover/30 p-3">
    <div class="min-w-0 flex-1">
      <div class="text-text-bright text-sm font-medium">{title}</div>
      <div class="text-text-muted text-xs mt-0.5">{description}</div>
    </div>
    <button
      type="button"
      role="switch"
      aria-checked={current ? current[field] : false}
      aria-label={title}
      disabled={!current || busy[field]}
      onclick={() => toggle(field)}
      data-testid="perm-toggle-{field}"
      class="relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors disabled:cursor-wait
             {current?.[field] ? 'bg-primary' : 'bg-bg-hover'}"
    >
      <span
        class="inline-block size-4 transform rounded-full bg-white transition-transform
               {current?.[field] ? 'translate-x-6' : 'translate-x-1'}"
      ></span>
    </button>
  </div>
{/snippet}

<section class="rounded-2xl border border-border bg-bg-input p-5" data-testid="admin-permissions">
  <div class="mb-4">
    <h2 class="text-text-bright text-base font-semibold">Berechtigungen</h2>
    <p class="text-text-muted text-xs mt-0.5">
      Was normale User dürfen. Admins (du selbst) sind von der Server-Erstellungs-Sperre
      ausgenommen; Einladungen sind hart auf den jeweiligen Guild-Owner beschränkt.
    </p>
  </div>

  {#if error}
    <p class="text-red-400 text-sm">Fehler: {error}</p>
  {:else if current}
    <div class="flex flex-col gap-2">
      {@render toggleRow(
        'allow_guild_creation',
        'Server-Erstellung',
        'Wenn aus, können nur Admins über das „+"-Symbol einen neuen Server erstellen.'
      )}
      {@render toggleRow(
        'allow_member_invites',
        'Einladungen verschicken',
        'Wenn aus, kann nur der Server-Owner Einladungs-Codes für seinen Server erstellen.'
      )}
    </div>
  {:else}
    <div class="text-text-muted text-sm">lade…</div>
  {/if}
</section>
