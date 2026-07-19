<!--
  Self-Host-only: Beitritts-Sperre (locked).
  Ein einziger Toggle: gesperrt = keine neuen Mitglieder mehr (auch nicht per
  Community-Invite oder öffentlicher Adresse). Bereits bestehende Mitglieder
  und der Owner sind unberührt.
  Liest/schreibt `locked` via PATCH /admin/permissions (chat-gateway).
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { toast } from 'svelte-sonner';
  import { adminApi } from '$lib/api/admin';
  import { m } from '$lib/paraglide/messages.js';

  let locked = $state<boolean | null>(null);
  let busy = $state(false);
  let error = $state<string | null>(null);

  onMount(async () => {
    try {
      const perms = await adminApi.getPermissions();
      locked = perms.locked;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  });

  async function toggle() {
    if (locked === null || busy) return;
    busy = true;
    try {
      const updated = await adminApi.patchPermissions({ locked: !locked });
      locked = updated.locked;
      toast.success(m.admin_join_locked_saved());
    } catch (e) {
      toast.error(m.admin_join_locked_save_failed(), {
        description: e instanceof Error ? e.message : String(e)
      });
    } finally {
      busy = false;
    }
  }
</script>

<section class="rounded-2xl border border-border bg-bg-input p-5" data-testid="admin-join-control">
  <div class="mb-4">
    <h2 class="text-text-bright text-base font-semibold">{m.admin_join_control_title()}</h2>
    <p class="text-text-muted text-xs mt-0.5">{m.admin_join_control_description()}</p>
  </div>

  {#if error}
    <p class="text-destructive text-sm">{m.admin_join_control_load_error({ error })}</p>
  {:else if locked === null}
    <div class="text-text-muted text-sm">{m.admin_join_control_loading()}</div>
  {:else}
    <label
      class="flex cursor-pointer items-start gap-3 rounded-xl border border-border bg-bg-hover/30 p-4 hover:bg-bg-hover"
      class:border-destructive={locked}
      data-testid="admin-join-locked-toggle"
    >
      <div class="relative mt-0.5 shrink-0">
        <input
          type="checkbox"
          class="sr-only"
          checked={locked}
          disabled={busy}
          onchange={toggle}
          data-testid="join-locked-checkbox"
        />
        <!-- Custom toggle track -->
        <div
          class="h-5 w-9 rounded-full transition-colors {locked
            ? 'bg-destructive/80'
            : 'bg-border'}"
        ></div>
        <!-- Thumb -->
        <div
          class="absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform {locked
            ? 'translate-x-4'
            : 'translate-x-0'}"
        ></div>
      </div>
      <div class="flex-1">
        <div class="text-text-bright text-sm font-medium">{m.admin_join_locked_label()}</div>
        <div class="text-text-muted text-xs mt-0.5">{m.admin_join_locked_description()}</div>
      </div>
    </label>
  {/if}
</section>
