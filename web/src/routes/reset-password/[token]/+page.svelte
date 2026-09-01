<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { passwordReset } from '$lib/api/auth';
  import { ApiError } from '$lib/api/client';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import FieldLabel from '$lib/components/form/FieldLabel.svelte';
  import * as Alert from '$lib/components/ui/alert/index.js';
  import OctagonXIcon from '@lucide/svelte/icons/octagon-x';
  import AuthCard from '$lib/components/AuthCard.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let password = $state('');
  let confirm = $state('');
  let error = $state<string | null>(null);
  let busy = $state(false);
  /** True iff the server returned a clear "token bad" status — we offer a
   *  direct re-request link in that case rather than just an error blob. */
  let tokenInvalid = $state(false);

  // Token is the dynamic URL segment. We expose it as readonly to the API call.
  const token = $derived(page.params.token ?? '');

  async function submit(e: Event) {
    e.preventDefault();
    error = null;
    if (password.length < 8) {
      error = m.reset_password_error_too_short();
      return;
    }
    if (password !== confirm) {
      error = m.reset_password_error_mismatch();
      return;
    }
    if (!token) {
      error = m.reset_password_error_no_token();
      tokenInvalid = true;
      return;
    }
    busy = true;
    try {
      await passwordReset(token, password);
      // Hand off to /login with a flag → login page shows the success toast.
      await goto('/login?reset=1', { replaceState: true });
    } catch (err) {
      if (err instanceof ApiError && (err.status === 400 || err.status === 410 || err.status === 404)) {
        tokenInvalid = true;
        error = m.reset_password_error_token_expired();
      } else {
        error = (err as Error).message;
      }
    } finally {
      busy = false;
    }
  }
</script>

<AuthCard
  headline={m.reset_password_brand_headline()}
  headlineSub={m.reset_password_brand_headline_sub()}
  description={m.reset_password_brand_description()}
  features={[m.reset_password_brand_feature_length(), m.reset_password_brand_feature_algo(), m.reset_password_brand_feature_instant()]}
>
    <form
      class="bg-card w-full max-w-md space-y-4 rounded-xl p-8 shadow-2xl"
      onsubmit={submit}
      aria-label="reset password form"
    >
      <header class="space-y-2 text-center">
        <img src="/pulse-mark.svg" alt="Pulse" width="56" height="56" class="mx-auto size-14" />
        <h1 class="text-card-foreground text-2xl font-semibold">{m.reset_password_title()}</h1>
      </header>

      <div class="space-y-1.5">
        <FieldLabel
          for="reset-password"
          required
          class="text-muted-foreground text-xs font-semibold uppercase tracking-wide"
        >
          {m.reset_password_label_new()}
        </FieldLabel>
        <Input
          id="reset-password"
          type="password"
          autocomplete="new-password"
          bind:value={password}
          required
          minlength={8}
          data-testid="reset-password"
        />
      </div>

      <div class="space-y-1.5">
        <FieldLabel
          for="reset-confirm"
          required
          class="text-muted-foreground text-xs font-semibold uppercase tracking-wide"
        >
          {m.reset_password_label_confirm()}
        </FieldLabel>
        <Input
          id="reset-confirm"
          type="password"
          autocomplete="new-password"
          bind:value={confirm}
          required
          minlength={8}
          data-testid="reset-confirm"
        />
      </div>

      {#if error}
        <Alert.Root variant="destructive" data-testid="reset-error">
          <OctagonXIcon />
          <Alert.Description>{error}</Alert.Description>
        </Alert.Root>
      {/if}

      <Button type="submit" class="w-full" disabled={busy} data-testid="reset-submit">
        {busy ? m.reset_password_submit_busy() : m.reset_password_submit()}
      </Button>

      {#if tokenInvalid}
        <p class="text-muted-foreground text-center text-sm">
          <a
            class="text-primary hover:underline"
            href="/forgot-password"
            data-testid="reset-request-new"
          >
            {m.reset_password_request_new_link()}
          </a>
        </p>
      {:else}
        <p class="text-muted-foreground text-center text-sm">
          <a class="text-primary hover:underline" href="/login">{m.reset_password_back_to_login()}</a>
        </p>
      {/if}
    </form>
</AuthCard>
