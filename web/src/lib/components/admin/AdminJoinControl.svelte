<!--
  Self-Host-only: Beitritts-Modus (open / invite_only / closed) + Code-Verwaltung.
  Liest/schreibt join_mode via PATCH /admin/permissions (chat-gateway).
  Bei invite_only wird die JoinInviteSection eingeblendet.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { toast } from 'svelte-sonner';
  import { Button } from '$lib/components/ui/button/index.js';
  import { adminApi, type JoinMode } from '$lib/api/admin';
  import JoinInviteSection from './JoinInviteSection.svelte';
  import SaveIcon from '@lucide/svelte/icons/save';
  import { m } from '$lib/paraglide/messages.js';

  let currentMode = $state<JoinMode | null>(null);
  let pick = $state<JoinMode>('open');
  let busy = $state(false);
  let error = $state<string | null>(null);

  onMount(async () => {
    try {
      const perms = await adminApi.getPermissions();
      currentMode = perms.join_mode;
      pick = perms.join_mode;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  });

  const dirty = $derived(currentMode !== null && pick !== currentMode);

  const modeLabels = $derived<Record<JoinMode, { title: string; description: string }>>({
    open: {
      title: m.admin_join_mode_open_title(),
      description: m.admin_join_mode_open_description()
    },
    invite_only: {
      title: m.admin_join_mode_invite_only_title(),
      description: m.admin_join_mode_invite_only_description()
    },
    closed: {
      title: m.admin_join_mode_closed_title(),
      description: m.admin_join_mode_closed_description()
    }
  });

  async function save() {
    if (!dirty || busy) return;
    busy = true;
    try {
      const updated = await adminApi.patchPermissions({ join_mode: pick });
      currentMode = updated.join_mode;
      toast.success(m.admin_join_mode_saved());
    } catch (e) {
      toast.error(m.admin_join_mode_save_failed(), {
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
    <p class="text-red-400 text-sm">{m.admin_join_control_load_error({ error })}</p>
  {:else if currentMode !== null}
    <div class="flex flex-col gap-2">
      {#each Object.entries(modeLabels) as [mode, info] (mode)}
        <label
          class="flex cursor-pointer items-start gap-3 rounded-xl border border-border bg-bg-hover/30 p-3 hover:bg-bg-hover"
          class:border-primary={pick === mode}
        >
          <input
            type="radio"
            value={mode}
            bind:group={pick}
            class="mt-1 accent-primary"
            data-testid="join-mode-{mode}"
          />
          <div class="flex-1">
            <div class="text-text-bright text-sm font-medium">{info.title}</div>
            <div class="text-text-muted text-xs mt-0.5">{info.description}</div>
          </div>
        </label>
      {/each}
    </div>

    <div class="mt-4 flex items-center justify-end">
      <Button onclick={save} disabled={!dirty || busy} data-testid="join-mode-save">
        <SaveIcon class="size-4" />
        {busy ? m.admin_join_mode_saving() : m.admin_join_mode_save()}
      </Button>
    </div>

    {#if currentMode === 'invite_only'}
      <JoinInviteSection />
    {/if}
  {:else}
    <div class="text-text-muted text-sm">{m.admin_join_control_loading()}</div>
  {/if}
</section>
