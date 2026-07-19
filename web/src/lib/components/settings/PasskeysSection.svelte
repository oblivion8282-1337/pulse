<script lang="ts">
  /**
   * Passkey management block in the "Sicherheit"-Tab. Lists the account's
   * registered passkeys (WebAuthn credentials) and hosts the add wizard.
   *
   * A passkey acts as a second factor on password login AND enables the
   * passwordless "Mit Passkey anmelden" button — see the login page.
   */
  import { onMount } from 'svelte';
  import { toast } from 'svelte-sonner';
  import KeyRoundIcon from '@lucide/svelte/icons/key-round';
  import PlusIcon from '@lucide/svelte/icons/plus';
  import { Button } from '$lib/components/ui/button';
  import {
    listPasskeys,
    webauthnSupported,
    type WebAuthnCredentialSummary
  } from '$lib/api/webauthn';
  import PasskeyRow from './PasskeyRow.svelte';
  import PasskeyAddDialog from './PasskeyAddDialog.svelte';
  import { m } from '$lib/paraglide/messages.js';
  import EmptyState from '$lib/components/feedback/EmptyState.svelte';
  import LoadingState from '$lib/components/feedback/LoadingState.svelte';

  const supported = webauthnSupported();
  let passkeys = $state<WebAuthnCredentialSummary[]>([]);
  let loading = $state(true);
  let addOpen = $state(false);

  onMount(async () => {
    if (!supported) {
      loading = false;
      return;
    }
    try {
      passkeys = await listPasskeys();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      loading = false;
    }
  });

  function onAdded(cred: WebAuthnCredentialSummary) {
    passkeys = [...passkeys, cred];
  }
  function onRenamed(cred: WebAuthnCredentialSummary) {
    passkeys = passkeys.map((p) => (p.id === cred.id ? cred : p));
  }
  function onRemoved(id: string) {
    passkeys = passkeys.filter((p) => p.id !== id);
  }
</script>

<section
  class="border-border bg-bg-input/40 flex flex-col gap-3 rounded-2xl border p-4"
  data-testid="passkeys-section"
>
  <div class="flex items-start gap-3">
    <span class="bg-bg-input text-text-muted flex size-9 items-center justify-center rounded-full">
      <KeyRoundIcon class="size-5" />
    </span>
    <div class="flex flex-col gap-0.5">
      <span class="text-text-bright text-sm font-medium">{m.passkeys_section_title()}</span>
      <span class="text-text-muted text-xs">
        {m.passkeys_section_description()}
      </span>
    </div>
  </div>

  {#if !supported}
    <p class="text-text-muted text-xs">
      {m.passkeys_section_unsupported()}
    </p>
  {:else if loading}
    <LoadingState label={m.passkeys_section_loading()} />
  {:else}
    {#if passkeys.length > 0}
      <ul class="flex flex-col gap-2">
        {#each passkeys as pk (pk.id)}
          <PasskeyRow passkey={pk} {onRenamed} {onRemoved} />
        {/each}
      </ul>
    {:else}
      <EmptyState message={m.passkeys_section_empty()} />
    {/if}

    <Button
      variant="secondary"
      size="xs"
      class="self-start"
      onclick={() => (addOpen = true)}
      data-testid="passkeys-add"
    >
      <PlusIcon class="size-3.5" />
      {m.passkeys_section_add_button()}
    </Button>
  {/if}
</section>

<PasskeyAddDialog bind:open={addOpen} {onAdded} />
