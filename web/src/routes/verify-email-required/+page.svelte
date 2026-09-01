<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { emailVerifySend, me } from '$lib/api/auth';
  import { forceTokenRefresh } from '$lib/api/client';
  import { auth } from '$lib/stores/auth.svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import * as Alert from '$lib/components/ui/alert/index.js';
  import AuthCard from '$lib/components/AuthCard.svelte';
  import MailWarningIcon from '@lucide/svelte/icons/mail-warning';
  import OctagonXIcon from '@lucide/svelte/icons/octagon-x';
  import LoadingState from '$lib/components/feedback/LoadingState.svelte';
  import { m } from '$lib/paraglide/messages.js';

  // `ready` gates the card so we don't flash it before the hydrate/redirect
  // decision. Not-signed-in → /login; already verified → /app.
  let ready = $state(false);
  let resending = $state(false);
  let resent = $state(false);
  let checking = $state(false);
  let stillPending = $state(false);
  let error = $state<string | null>(null);

  onMount(async () => {
    await auth.hydrate();
    if (!auth.isAuthenticated) {
      await goto('/login', { replaceState: true });
      return;
    }
    if (!auth.user?.email_verification_pending) {
      // Verified already (or gate off) — there's nothing to block.
      await goto('/app', { replaceState: true });
      return;
    }
    ready = true;
  });

  async function resend() {
    if (resending) return;
    resending = true;
    error = null;
    try {
      await emailVerifySend();
      resent = true;
    } catch (err) {
      error = (err as Error).message;
    } finally {
      resending = false;
    }
  }

  async function recheck() {
    if (checking) return;
    checking = true;
    error = null;
    stillPending = false;
    try {
      // Force a token rotation first: if the user verified in another tab,
      // their access token still carries `email_blocked` until refreshed.
      await forceTokenRefresh();
      const user = await me();
      auth.setUser(user);
      if (user.email_verification_pending) {
        stillPending = true;
      } else {
        await goto('/app', { replaceState: true });
      }
    } catch (err) {
      error = (err as Error).message;
    } finally {
      checking = false;
    }
  }
</script>

<AuthCard
  headline={m.verify_email_brand_headline()}
  headlineSub={m.verify_email_brand_headline_sub()}
  description={m.verify_email_brand_description()}
  features={[
    m.verify_email_brand_feature_link_validity(),
    m.verify_email_brand_feature_typo_protection(),
    m.verify_email_brand_feature_no_relogin(),
  ]}
>
    {#if !ready}
      <LoadingState density="page" />
    {:else}
      <div
        class="bg-card w-full max-w-md space-y-4 rounded-xl p-8 text-center shadow-2xl"
        data-testid="verify-required-card"
      >
        <div class="bg-bg-input mx-auto flex size-14 items-center justify-center rounded-full">
          <MailWarningIcon class="text-primary size-7" />
        </div>
        <h1 class="text-card-foreground text-2xl font-semibold">
          {m.verify_email_heading()}
        </h1>
        <p class="text-muted-foreground text-sm">
          {m.verify_email_intro_before()}
          <span class="text-card-foreground font-medium">{auth.user?.email}</span>
          {m.verify_email_intro_after()}
        </p>

        {#if error}
          <Alert.Root variant="destructive" data-testid="verify-required-error">
            <OctagonXIcon />
            <Alert.Description>{error}</Alert.Description>
          </Alert.Root>
        {/if}

        {#if stillPending}
          <p class="text-muted-foreground text-sm" data-testid="verify-required-still">
            {m.verify_email_still_pending()}
          </p>
        {/if}

        <Button
          class="w-full"
          onclick={recheck}
          disabled={checking}
          data-testid="verify-required-recheck"
        >
          {checking ? m.verify_email_recheck_checking() : m.verify_email_recheck_confirm()}
        </Button>

        {#if resent}
          <p class="text-muted-foreground text-sm" data-testid="verify-required-resent">
            {m.verify_email_resent_confirmation()}
          </p>
        {:else}
          <Button
            variant="outline"
            class="w-full"
            onclick={resend}
            disabled={resending}
            data-testid="verify-required-resend"
          >
            {resending ? m.verify_email_resend_sending() : m.verify_email_resend_button()}
          </Button>
        {/if}

        <Button
          variant="link"
          size="xs"
          onclick={() => auth.signOut()}
          data-testid="verify-required-signout"
        >
          {m.verify_email_sign_out_link()}
        </Button>
      </div>
    {/if}
</AuthCard>
