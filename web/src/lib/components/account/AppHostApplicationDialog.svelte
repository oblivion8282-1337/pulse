<!--
  Modal-Dialog zum Einreichen eines App-Hosting-Freischaltungs-Antrags.

  Zweck: User ohne ``self_host_enabled`` beantragen hier, dass das Pulse-Team
  die Funktion für ihr Konto freischaltet. Disjoint zum Server-Hosting-Antrag
  (``SelfHostApplication``) — App-Hosting läuft auf dem Gerät des Users, kein
  VPS/Hostname nötig.

  Flow: Dialog → submit → POST /me/app-host-application → Status "ausstehend"
  (polling via [[myAppHostApplications]] für Live-Update auf approved/rejected).
-->
<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { m } from '$lib/paraglide/messages.js';
  import {
    appHostApplicationsApi,
    type AppHostPurpose
  } from '$lib/api/appHostApplications';
  import { myAppHostApplications } from '$lib/stores/myAppHostApplications.svelte';

  let open = $state(false);
  let purpose = $state<AppHostPurpose>('privat');
  let message = $state('');
  let submitting = $state(false);
  let formError = $state<string | null>(null);

  function reset() {
    purpose = 'privat';
    message = '';
    formError = null;
  }

  async function submit() {
    formError = null;
    submitting = true;
    try {
      const created = await appHostApplicationsApi.submitApplication({
        purpose,
        message: message.trim() || null
      });
      myAppHostApplications.register(created);
      open = false;
      reset();
    } catch (e) {
      formError = e instanceof Error ? e.message : String(e);
    } finally {
      submitting = false;
    }
  }
</script>

<Dialog.Root bind:open onOpenChange={(v) => { if (!v) reset(); }}>
  <Dialog.Trigger>
    {#snippet child({ props })}
      <Button {...props} data-testid="app-host-apply-trigger">
        {m.app_host_apply_button()}
      </Button>
    {/snippet}
  </Dialog.Trigger>
  <Dialog.Portal>
    <Dialog.Overlay />
    <Dialog.Content class="max-w-md" data-testid="app-host-apply-dialog">
      <Dialog.Header>
        <Dialog.Title>{m.app_host_apply_title()}</Dialog.Title>
        <Dialog.Description>{m.app_host_apply_intro()}</Dialog.Description>
      </Dialog.Header>

      <form
        onsubmit={(e) => { e.preventDefault(); void submit(); }}
        class="flex flex-col gap-3"
      >
        <div class="flex flex-col gap-1">
          <label class="text-text-bright text-xs font-medium" for="aha-purpose">
            {m.app_host_apply_purpose_label()}
          </label>
          <select
            id="aha-purpose"
            bind:value={purpose}
            class="bg-bg-input border-border text-text-bright rounded-xl border px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
          >
            <option value="privat">{m.app_host_apply_purpose_privat()}</option>
            <option value="verein">{m.app_host_apply_purpose_verein()}</option>
            <option value="firma">{m.app_host_apply_purpose_firma()}</option>
            <option value="sonst">{m.app_host_apply_purpose_sonst()}</option>
          </select>
        </div>

        <div class="flex flex-col gap-1">
          <label class="text-text-bright text-xs font-medium" for="aha-message">
            {m.app_host_apply_message_label()}
            <span class="text-text-muted font-normal">{m.app_host_apply_message_optional()}</span>
          </label>
          <textarea
            id="aha-message"
            bind:value={message}
            rows="3"
            maxlength="2000"
            placeholder={m.app_host_apply_message_placeholder()}
            class="bg-bg-input border-border text-text-bright placeholder:text-text-muted resize-none rounded-xl border px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
          ></textarea>
        </div>

        {#if formError}
          <p class="text-red-400 text-xs">{formError}</p>
        {/if}

        <div class="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onclick={() => (open = false)}
            class="rounded-xl border border-border px-4 py-2 text-sm text-text-base hover:bg-bg-hover"
          >
            {m.app_host_apply_cancel()}
          </button>
          <button
            type="submit"
            disabled={submitting}
            class="bg-primary hover:bg-primary/90 text-white rounded-xl px-4 py-2 text-sm font-medium transition-colors disabled:opacity-60"
          >
            {submitting ? m.app_host_apply_submitting() : m.app_host_apply_submit()}
          </button>
        </div>
      </form>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>