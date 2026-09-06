<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { emailVerifyConfirm, emailVerifySend, me } from '$lib/api/auth';
  import { forceTokenRefresh } from '$lib/api/client';
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
  let resending = $state(false);
  let resent = $state(false);

  const token = $derived(page.params.token ?? '');

  onMount(async () => {
    if (!token) {
      status = 'error';
      error = m.verify_email_invalid_token();
      return;
    }
    try {
      await emailVerifyConfirm(token);
      status = 'ok';
      // If signed in on this device: force a token rotation so the fresh
      // access token drops the stale `email_blocked` claim, then refresh the
      // cached user so the routing gate waves them straight into /app.
      if (loadTokens()) {
        try {
          await forceTokenRefresh();
          auth.setUser(await me());
        } catch {
          /* non-critical — they can simply log in again */
        }
      }
    } catch (err) {
      status = 'error';
      error = (err as Error).message;
    }
  });

  async function continueToApp() {
    await goto(auth.isAuthenticated ? '/app' : '/login?verified=1');
  }

  async function resend() {
    if (resending) return;
    resending = true;
    try {
      await emailVerifySend();
      resent = true;
    } catch (err) {
      error = (err as Error).message;
    } finally {
      resending = false;
    }
  }
</script>

<AuthCard
  headline={m.verify_email_brand_headline()}
  description={m.verify_email_brand_description()}
  features={[m.verify_email_feature_single_use(), m.verify_email_feature_expires(), m.verify_email_feature_protection()]}
>
    <div
      class="bg-card w-full max-w-md space-y-4 rounded-xl p-8 text-center shadow-2xl"
      data-testid="verify-email-card"
    >
      {#if status === 'pending'}
        <div
          class="bg-bg-input mx-auto flex size-14 items-center justify-center rounded-full"
        >
          <Loader2Icon class="text-primary size-7 motion-safe:animate-spin" />
        </div>
        <h1 class="text-card-foreground text-2xl font-semibold">{m.verify_email_pending_title()}</h1>
        <p class="text-muted-foreground text-sm">{m.verify_email_pending_subtitle()}</p>
      {:else if status === 'ok'}
        <div
          class="bg-bg-input mx-auto flex size-14 items-center justify-center rounded-full"
        >
          <MailCheckIcon class="text-primary size-7" />
        </div>
        <h1 class="text-card-foreground text-2xl font-semibold" data-testid="verify-email-ok">
          {m.verify_email_ok_title()}
        </h1>
        <p class="text-muted-foreground text-sm">{m.verify_email_ok_subtitle()}</p>
        <Button class="w-full" onclick={continueToApp} data-testid="verify-email-continue">
          {m.verify_email_continue_button()}
        </Button>
      {:else}
        <Alert.Root variant="destructive" data-testid="verify-email-error">
          <OctagonXIcon />
          <Alert.Description>
            {error ?? m.verify_email_link_invalid()}
          </Alert.Description>
        </Alert.Root>
        {#if auth.isAuthenticated}
          {#if resent}
            <p class="text-text-muted text-sm" data-testid="verify-email-resent">
              {m.verify_email_resent_message()}
            </p>
          {:else}
            <Button
              class="w-full"
              onclick={resend}
              disabled={resending}
              data-testid="verify-email-resend"
            >
              {resending ? m.verify_email_resend_sending() : m.verify_email_resend_button()}
            </Button>
          {/if}
        {:else}
          <p class="text-muted-foreground text-sm">
            <a class="text-primary hover:underline" href="/login">{m.verify_email_sign_in_link()}</a>, {m.verify_email_sign_in_hint()}
          </p>
        {/if}
      {/if}
    </div>
</AuthCard>
