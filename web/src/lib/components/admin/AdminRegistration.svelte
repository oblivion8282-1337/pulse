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

  const labels: Record<RegistrationMode, { title: string; description: string }> = {
    open: {
      title: 'Offen',
      description: 'Jede:r kann sich registrieren. Nichts blockiert /register.'
    },
    invite_only: {
      title: 'Nur per Einladung',
      description:
        'Registrierung verlangt einen gültigen Einladungscode. Codes erstellst und verwaltest du unten.'
    },
    closed: {
      title: 'Geschlossen',
      description: '/register lehnt alle neuen Registrierungen ab.'
    }
  };

  async function save() {
    if (!dirty || busy) return;
    busy = true;
    try {
      const next = await adminApi.patchAuthSettings({ registration_mode: pick });
      current = next.registration_mode;
      toast.success('Registrierung aktualisiert');
    } catch (e) {
      toast.error('Speichern fehlgeschlagen', {
        description: e instanceof Error ? e.message : String(e)
      });
    } finally {
      busy = false;
    }
  }
</script>

<section class="rounded-2xl border border-border bg-bg-input p-5" data-testid="admin-registration">
  <div class="mb-4">
    <h2 class="text-text-bright text-base font-semibold">Registrierung</h2>
    <p class="text-text-muted text-xs mt-0.5">Wer kann sich für deinen Server anmelden?</p>
  </div>

  {#if error}
    <p class="text-red-400 text-sm">Fehler: {error}</p>
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
        {busy ? 'Speichere…' : 'Speichern'}
      </Button>
    </div>

    <!-- Code-Verwaltung nur im (gespeicherten) invite_only-Modus. -->
    {#if current === 'invite_only'}
      <RegistrationInviteSection />
    {/if}
  {:else}
    <div class="text-text-muted text-sm">lade…</div>
  {/if}
</section>
