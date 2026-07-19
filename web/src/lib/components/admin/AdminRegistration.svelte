<!--
  Registration mode selector. Patches auth-svc's auth_settings singleton.
  Effect is immediate — the next POST /register call sees the new mode.

  ``invite_only`` requires a valid invite code on /register; codes are
  issued + managed below (RegistrationInviteSection / auth-svc invite routes).
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { toast } from 'svelte-sonner';
  import { Button } from '$lib/components/ui/button/index.js';
  import { adminApi, type RegistrationMode } from '$lib/api/admin';
  import RegistrationInviteSection from './RegistrationInviteSection.svelte';
  import SaveIcon from '@lucide/svelte/icons/save';
  import { m } from '$lib/paraglide/messages.js';
  import FieldError from '$lib/components/feedback/FieldError.svelte';
  import LoadingState from '$lib/components/feedback/LoadingState.svelte';

  let current = $state<RegistrationMode | null>(null);
  let pick = $state<RegistrationMode>('open');
  let busy = $state(false);
  let error = $state<string | null>(null);

  onMount(async () => {
    try {
      const s = await adminApi.getAuthSettings();
      current = s.registration_mode;
      pick = s.registration_mode;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  });

  const dirty = $derived(current !== null && pick !== current);

  const labels = $derived<Record<RegistrationMode, { title: string; description: string }>>({
    open: {
      title: m.admin_registration_mode_open_title(),
      description: m.admin_registration_mode_open_description()
    },
    invite_only: {
      title: m.admin_registration_mode_invite_only_title(),
      description: m.admin_registration_mode_invite_only_description()
    },
    closed: {
      title: m.admin_registration_mode_closed_title(),
      description: m.admin_registration_mode_closed_description()
    }
  });

  async function save() {
    if (!dirty || busy) return;
    busy = true;
    try {
      const next = await adminApi.patchAuthSettings({ registration_mode: pick });
      current = next.registration_mode;
      toast.success(m.admin_registration_saved());
    } catch (e) {
      toast.error(m.admin_registration_save_failed(), {
        description: e instanceof Error ? e.message : String(e)
      });
    } finally {
      busy = false;
    }
  }
</script>

<section class="rounded-2xl border border-border bg-bg-input p-5" data-testid="admin-registration">
  <div class="mb-4">
    <h2 class="text-text-bright text-base font-semibold">{m.admin_registration_title()}</h2>
    <p class="text-text-muted text-xs mt-0.5">{m.admin_registration_subtitle()}</p>
  </div>

  {#if error}
    <FieldError message={m.admin_registration_load_error({ error })} />
  {:else if current !== null}
    <div class="flex flex-col gap-2">
      {#each Object.entries(labels) as [mode, info] (mode)}
        <label
          class="flex cursor-pointer items-start gap-3 rounded-xl border border-border bg-bg-hover/30 p-3 hover:bg-bg-hover"
          class:border-primary={pick === mode}
        >
          <input
            type="radio"
            value={mode}
            bind:group={pick}
            class="mt-1 accent-primary"
            data-testid="reg-mode-{mode}"
          />
          <div class="flex-1">
            <div class="text-text-bright text-sm font-medium">{info.title}</div>
            <div class="text-text-muted text-xs mt-0.5">{info.description}</div>
          </div>
        </label>
      {/each}
    </div>

    <div class="mt-4 flex items-center justify-end">
      <Button onclick={save} disabled={!dirty || busy} data-testid="reg-mode-save">
        <SaveIcon class="size-4" />
        {busy ? m.admin_registration_saving() : m.admin_registration_save()}
      </Button>
    </div>

    <!-- Code-Verwaltung nur im (gespeicherten) invite_only-Modus. -->
    {#if current === 'invite_only'}
      <RegistrationInviteSection />
    {/if}
  {:else}
    <LoadingState label={m.admin_registration_loading()} />
  {/if}
</section>
