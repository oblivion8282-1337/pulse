<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { emailVerifySend, me } from '$lib/api/auth';
  import { forceTokenRefresh } from '$lib/api/client';
  import { auth } from '$lib/stores/auth.svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import * as Alert from '$lib/components/ui/alert/index.js';
  import AuthBrandPanel from '$lib/components/AuthBrandPanel.svelte';
  import MailWarningIcon from '@lucide/svelte/icons/mail-warning';
  import OctagonXIcon from '@lucide/svelte/icons/octagon-x';
  import Loader2Icon from '@lucide/svelte/icons/loader-2';

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

<div class="flex min-h-dvh">
  <AuthBrandPanel
    headline="Fast geschafft."
    headlineSub="Nur noch die E-Mail."
    description="Wir haben dir einen Bestätigungslink geschickt. Sobald du ihn anklickst, ist dein Zugang frei."
    features={[
      'Link gilt 24 Stunden',
      'Schützt vor Tippfehlern in der Adresse',
      'Kein erneutes Anmelden nötig',
    ]}
  />

  <div class="flex flex-1 items-center justify-center p-4 md:flex-none md:basis-[46%]">
    {#if !ready}
      <Loader2Icon class="text-primary size-7 motion-safe:animate-spin" />
    {:else}
      <div
        class="bg-card w-full max-w-md space-y-4 rounded-xl p-8 text-center shadow-2xl"
        data-testid="verify-required-card"
      >
        <div class="bg-bg-input mx-auto flex size-14 items-center justify-center rounded-full">
          <MailWarningIcon class="text-primary size-7" />
        </div>
        <h1 class="text-card-foreground text-2xl font-semibold">
          Bestätige deine E-Mail-Adresse
        </h1>
        <p class="text-muted-foreground text-sm">
          Bevor du Pulse nutzen kannst, musst du deine Adresse bestätigen. Wir
          haben einen Link an
          <span class="text-card-foreground font-medium">{auth.user?.email}</span>
          geschickt — schau auch im Spam-Ordner nach.
        </p>

        {#if error}
          <Alert.Root variant="destructive" data-testid="verify-required-error">
            <OctagonXIcon />
            <Alert.Description>{error}</Alert.Description>
          </Alert.Root>
        {/if}

        {#if stillPending}
          <p class="text-muted-foreground text-sm" data-testid="verify-required-still">
            Noch nicht bestätigt — klick den Link in der Mail und versuch es dann
            erneut.
          </p>
        {/if}

        <Button
          class="w-full"
          onclick={recheck}
          disabled={checking}
          data-testid="verify-required-recheck"
        >
          {checking ? 'Prüfe…' : 'Ich habe bestätigt'}
        </Button>

        {#if resent}
          <p class="text-muted-foreground text-sm" data-testid="verify-required-resent">
            Neuer Link verschickt — schau in dein Postfach.
          </p>
        {:else}
          <Button
            variant="outline"
            class="w-full"
            onclick={resend}
            disabled={resending}
            data-testid="verify-required-resend"
          >
            {resending ? 'Senden…' : 'Link erneut senden'}
          </Button>
        {/if}

        <button
          type="button"
          class="text-muted-foreground hover:text-card-foreground text-xs underline"
          onclick={() => auth.signOut()}
          data-testid="verify-required-signout"
        >
          Mit einem anderen Konto anmelden
        </button>
      </div>
    {/if}
  </div>
</div>
