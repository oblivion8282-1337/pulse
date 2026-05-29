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
  // Working copy of the size-limit input. Stored as KB for human input;
  // converted to bytes on save. Bound to <input type=number>; "" = empty
  // (user is editing) until they blur or press Speichern.
  let soundLimitKb = $state<number | ''>('');
  let soundLimitBusy = $state(false);

  onMount(async () => {
    try {
      current = await adminApi.getPermissions();
      soundLimitKb = Math.round(current.guild_sound_max_size_bytes / 1024);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  });

  async function toggle(field: 'allow_guild_creation' | 'allow_member_invites') {
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

  async function saveSoundLimit() {
    if (!current || soundLimitBusy) return;
    const kb = typeof soundLimitKb === 'number' ? soundLimitKb : NaN;
    // Backend accepts 4096 (4 KB) – 5 * 1024 * 1024 (5 MB). Mirror here
    // so the toast tells the user *before* the round-trip what the cap is.
    if (!Number.isFinite(kb) || kb < 4 || kb > 5120) {
      toast.error('Ungültiger Wert', { description: 'Bitte 4 – 5120 KB.' });
      return;
    }
    soundLimitBusy = true;
    try {
      const updated = await adminApi.patchPermissions({
        guild_sound_max_size_bytes: Math.round(kb * 1024)
      });
      current = updated;
      soundLimitKb = Math.round(updated.guild_sound_max_size_bytes / 1024);
      toast.success('Größenlimit gespeichert');
    } catch (e) {
      toast.error('Speichern fehlgeschlagen', {
        description: e instanceof Error ? e.message : String(e)
      });
    } finally {
      soundLimitBusy = false;
    }
  }
</script>

{#snippet toggleRow(field: 'allow_guild_creation' | 'allow_member_invites', title: string, description: string)}
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
      Was normale User dürfen. Admins (du selbst) sind von der Community-Erstellungs-Sperre
      ausgenommen; Einladungen sind hart auf den jeweiligen Community-Owner beschränkt.
    </p>
  </div>

  {#if error}
    <p class="text-red-400 text-sm">Fehler: {error}</p>
  {:else if current}
    <div class="flex flex-col gap-2">
      {@render toggleRow(
        'allow_guild_creation',
        'Community-Erstellung',
        'Wenn aus, können nur Admins über das „+"-Symbol eine neue Community erstellen.'
      )}
      {@render toggleRow(
        'allow_member_invites',
        'Einladungen verschicken',
        'Wenn aus, kann nur der Community-Owner Einladungs-Codes für seine Community erstellen.'
      )}

      <div class="flex flex-col gap-2 rounded-xl border border-border bg-bg-hover/30 p-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div class="min-w-0 flex-1">
          <div class="text-text-bright text-sm font-medium">Sound-Upload-Limit pro Datei</div>
          <div class="text-text-muted text-xs mt-0.5">
            Maximale Größe einer hochgeladenen Sound-Datei pro Community.
            Gilt für jede Sound-ID einzeln (13 Slots × Limit). 4 – 5120 KB.
          </div>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <input
            type="number"
            min="4"
            max="5120"
            step="1"
            bind:value={soundLimitKb}
            class="w-24 rounded-md border border-border bg-bg-input px-2 py-1 text-right text-sm tabular-nums text-text-bright focus:border-primary focus:outline-none"
            data-testid="sound-limit-input"
            aria-label="Maximalgröße in KB"
          />
          <span class="text-text-muted text-xs">KB</span>
          <button
            type="button"
            disabled={soundLimitBusy || soundLimitKb === '' || Math.round(current.guild_sound_max_size_bytes / 1024) === soundLimitKb}
            onclick={saveSoundLimit}
            class="rounded-md bg-primary px-3 py-1 text-xs font-medium text-white transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-30"
            data-testid="sound-limit-save"
          >
            Speichern
          </button>
        </div>
      </div>
    </div>
  {:else}
    <div class="text-text-muted text-sm">lade…</div>
  {/if}
</section>
