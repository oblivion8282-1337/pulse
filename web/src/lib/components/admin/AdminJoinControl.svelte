<!--
  Self-Host-only: Beitritts-Sperre (locked).
  Ein einziger Toggle: gesperrt = keine neuen Mitglieder mehr (auch nicht per
  Community-Invite oder öffentlicher Adresse). Bereits bestehende Mitglieder
  und der Owner sind unberührt.
  Liest/schreibt `locked` via PATCH /admin/permissions (chat-gateway).
-->
<script lang="ts">
import { errText } from '$lib/utils/errText';
  import { onMount } from 'svelte';
  import { toast } from 'svelte-sonner';
  import { adminApi } from '$lib/api/admin';
  import { m } from '$lib/paraglide/messages.js';
  import Switch from '$lib/components/form/Switch.svelte';
  import FieldError from '$lib/components/feedback/FieldError.svelte';
  import LoadingState from '$lib/components/feedback/LoadingState.svelte';

  let locked = $state<boolean | null>(null);
  let busy = $state(false);
  let error = $state<string | null>(null);

  onMount(async () => {
    try {
      const perms = await adminApi.getPermissions();
      locked = perms.locked;
    } catch (e) {
      error = errText(e);
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
        description: errText(e)
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
    <FieldError message={m.admin_join_control_load_error({ error })} />
  {:else if locked === null}
    <LoadingState label={m.admin_join_control_loading()} />
  {:else}
    <div
      class="flex items-start gap-3 rounded-xl border border-border bg-bg-hover/30 p-4 hover:bg-bg-hover"
      data-testid="admin-join-locked-toggle"
    >
      <Switch
        checked={locked}
        onCheckedChange={toggle}
        disabled={busy}
        aria-label={m.admin_join_locked_label()}
        data-testid="join-locked-checkbox"
        class="mt-0.5"
      />
      <div class="flex-1">
        <div class="text-text-bright text-sm font-medium">{m.admin_join_locked_label()}</div>
        <div class="text-text-muted text-xs mt-0.5">{m.admin_join_locked_description()}</div>
      </div>
    </div>
  {/if}
</section>
