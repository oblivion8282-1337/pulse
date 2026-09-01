<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { confirmEmailChange, me } from '$lib/api/auth';
  import { loadTokens } from '$lib/api/storage';
  import { auth } from '$lib/stores/auth.svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import * as Alert from '$lib/components/ui/alert/index.js';
  import OctagonXIcon from '@lucide/svelte/icons/octagon-x';
  import MailCheckIcon from '@lucide/svelte/icons/mail-check';
  import Loader2Icon from '@lucide/svelte/icons/loader-2';
  import AuthCard from '$lib/components/AuthCard.svelte';
  import { m } from '$lib/paraglide/messages.js';

  type Status = 'pending' | 'ok' | 'error';
  let status = $state<Status>('pending');
  let error = $state<string | null>(null);

  const token = $derived(page.params.token ?? '');

  onMount(async () => {
    if (!token) {
      status = 'error';
      error = m.verify_email_change_invalid_token();
      return;
    }
    try {
      await confirmEmailChange(token);
      status = 'ok';
      // If signed in on this device, refresh the cached user so the new email
      // shows up immediately in settings.
      if (loadTokens()) {
        try {
          auth.setUser(await me());
        } catch {
          /* non-critical — the next /me fetch will pick it up */
        }
      }
    } catch (err) {
      status = 'error';
      error = (err as Error).message;
    }
  });

  async function done() {
    await goto(auth.isAuthenticated ? '/app' : '/login');
  }
</script>

<AuthCard
  headline={m.verify_email_change_brand_headline()}
  description={m.verify_email_change_brand_description()}
  features={[m.verify_email_feature_single_use(), m.verify_email_feature_expires(), m.verify_email_feature_protection()]}
>
    <div
      class="bg-card w-full max-w-md space-y-4 rounded-xl p-8 text-center shadow-2xl"
      data-testid="verify-email-change-card"
    >
      {#if status === 'pending'}
        <div class="bg-bg-input mx-auto flex size-14 items-center justify-center rounded-full">
          <Loader2Icon class="text-primary size-7 motion-safe:animate-spin" />
        </div>
        <h1 class="text-card-foreground text-2xl font-semibold">
          {m.verify_email_change_pending_title()}
        </h1>
        <p class="text-muted-foreground text-sm">{m.verify_email_change_pending_subtitle()}</p>
      {:else if status === 'ok'}
        <div class="bg-bg-input mx-auto flex size-14 items-center justify-center rounded-full">
          <MailCheckIcon class="text-primary size-7" />
        </div>
        <h1 class="text-card-foreground text-2xl font-semibold" data-testid="verify-email-change-ok">
          {m.verify_email_change_ok_title()}
        </h1>
        <p class="text-muted-foreground text-sm">{m.verify_email_change_ok_subtitle()}</p>
        <Button class="w-full" onclick={done} data-testid="verify-email-change-continue">
          {m.verify_email_change_continue_button()}
        </Button>
      {:else}
        <Alert.Root variant="destructive" data-testid="verify-email-change-error">
          <OctagonXIcon />
          <Alert.Description>
            {error ?? m.verify_email_change_link_invalid()}
          </Alert.Description>
        </Alert.Root>
        <p class="text-muted-foreground text-sm">
          <a class="text-primary hover:underline" href="/app">{m.verify_email_change_back_link()}</a>
        </p>
      {/if}
    </div>
</AuthCard>
