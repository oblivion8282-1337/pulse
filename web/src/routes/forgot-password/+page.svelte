<script lang="ts">
  import { passwordForgot } from '$lib/api/auth';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import FieldLabel from '$lib/components/form/FieldLabel.svelte';
  import * as Alert from '$lib/components/ui/alert/index.js';
  import OctagonXIcon from '@lucide/svelte/icons/octagon-x';
  import MailCheckIcon from '@lucide/svelte/icons/mail-check';
  import AuthCard from '$lib/components/AuthCard.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let emailOrUsername = $state('');
  let error = $state<string | null>(null);
  let busy = $state(false);
  let submitted = $state(false);

  async function submit(e: Event) {
    e.preventDefault();
    error = null;
    busy = true;
    try {
      await passwordForgot(emailOrUsername.trim());
      submitted = true;
    } catch (err) {
      // The backend always returns 204 for enumeration prevention; a thrown
      // error means a transport/server problem. Show it generically.
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<AuthCard
  headline={m.forgot_password_brand_headline()}
  headlineSub={m.forgot_password_brand_headline_sub()}
  description={m.forgot_password_brand_description()}
  features={[
    m.forgot_password_feature_link_expires(),
    m.forgot_password_feature_username_works(),
    m.forgot_password_feature_argon2(),
  ]}
>
    {#if submitted}
      <div
        class="bg-card w-full max-w-md space-y-4 rounded-xl p-8 text-center shadow-2xl"
        data-testid="forgot-success"
      >
        <div
          class="bg-bg-input mx-auto flex size-14 items-center justify-center rounded-full"
        >
          <MailCheckIcon class="text-primary size-7" />
        </div>
        <h1 class="text-card-foreground text-2xl font-semibold">{m.forgot_password_check_inbox_title()}</h1>
        <p class="text-muted-foreground text-sm">
          {m.forgot_password_check_inbox_body()}
        </p>
        <a
          class="text-primary inline-block text-sm hover:underline"
          href="/login"
          data-testid="forgot-back-to-login"
        >
          {m.forgot_password_back_to_login()}
        </a>
      </div>
    {:else}
      <form
        class="bg-card w-full max-w-md space-y-4 rounded-xl p-8 shadow-2xl"
        onsubmit={submit}
        aria-label="forgot password form"
      >
        <header class="space-y-2 text-center">
          <img src="/pulse-mark.svg" alt="Pulse" width="56" height="56" class="mx-auto size-14" />
          <h1 class="text-card-foreground text-2xl font-semibold">{m.forgot_password_title()}</h1>
          <p class="text-muted-foreground text-sm">
            {m.forgot_password_subtitle()}
          </p>
        </header>

        <div class="space-y-1.5">
          <FieldLabel
            for="forgot-identifier"
            required
            class="text-muted-foreground text-xs font-semibold uppercase tracking-wide"
          >
            {m.forgot_password_email_or_username_label()}
          </FieldLabel>
          <Input
            id="forgot-identifier"
            type="text"
            autocomplete="username"
            bind:value={emailOrUsername}
            required
            data-testid="forgot-identifier"
          />
        </div>

        {#if error}
          <Alert.Root variant="destructive" data-testid="forgot-error">
            <OctagonXIcon />
            <Alert.Description>{error}</Alert.Description>
          </Alert.Root>
        {/if}

        <Button type="submit" class="w-full" disabled={busy} data-testid="forgot-submit">
          {busy ? m.forgot_password_submit_busy() : m.forgot_password_submit_idle()}
        </Button>

        <p class="text-muted-foreground text-center text-sm">
          <a class="text-primary hover:underline" href="/login">{m.forgot_password_back_to_login()}</a>
        </p>
      </form>
    {/if}
  </AuthCard>
