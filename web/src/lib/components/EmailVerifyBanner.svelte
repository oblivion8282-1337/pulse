<script lang="ts">
  import { onMount } from 'svelte';
  import { toast } from 'svelte-sonner';
  import { emailVerifySend } from '$lib/api/auth';
  import { auth } from '$lib/stores/auth.svelte';
  import MailWarningIcon from '@lucide/svelte/icons/mail-warning';
  import XIcon from '@lucide/svelte/icons/x';

  /**
   * Banner shown in /app whenever the signed-in user has no `email_verified_at`.
   *
   *   - `dismissed` lives only in `sessionStorage` so it reappears on every fresh
   *     tab/login. Per-session dismiss is the right knob: the user expressly said
   *     "stop nagging me right now" — but a *new* session means they may have
   *     forgotten about it.
   *   - The resend button has a 60-second client-side cooldown after each click
   *     so a user mashing it doesn't blow through the server-side rate limit
   *     (the backend will still enforce its own limit; this is just UX).
   */

  const DISMISS_KEY = 'pulse.emailVerifyBanner.dismissed';
  const COOLDOWN_SECS = 60;

  let dismissed = $state(false);
  let busy = $state(false);
  let cooldown = $state(0);
  let timer: ReturnType<typeof setInterval> | null = null;

  onMount(() => {
    try {
      dismissed = sessionStorage.getItem(DISMISS_KEY) === '1';
    } catch {
      dismissed = false;
    }
    return () => {
      if (timer) clearInterval(timer);
    };
  });

  // Treat absent (undefined) as null — legacy users seeded before the
  // backend column existed have no value, but they aren't *verified* either.
  // The banner stays hidden until the auth-store knows about a user at all.
  const showBanner = $derived(
    auth.user !== null &&
      (auth.user.email_verified_at === null || auth.user.email_verified_at === undefined) &&
      !dismissed
  );

  function dismiss() {
    dismissed = true;
    try {
      sessionStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* private-browsing / quota — just keep the in-memory flag */
    }
  }

  function startCooldown() {
    cooldown = COOLDOWN_SECS;
    if (timer) clearInterval(timer);
    timer = setInterval(() => {
      cooldown -= 1;
      if (cooldown <= 0 && timer) {
        clearInterval(timer);
        timer = null;
        cooldown = 0;
      }
    }, 1000);
  }

  async function resend() {
    if (busy || cooldown > 0) return;
    busy = true;
    try {
      await emailVerifySend();
      toast.success('Email geschickt — prüfe dein Postfach.');
      startCooldown();
    } catch (err) {
      toast.error('Senden fehlgeschlagen', { description: (err as Error).message });
    } finally {
      busy = false;
    }
  }
</script>

{#if showBanner}
  <div
    class="bg-bg-input border-border text-text-base flex items-center gap-3 border-b px-4 py-2 text-sm"
    data-testid="email-verify-banner"
    role="status"
  >
    <MailWarningIcon class="text-primary size-4 shrink-0" />
    <span class="flex-1">
      Bitte bestätige deine Email-Adresse.
    </span>
    <button
      type="button"
      onclick={resend}
      disabled={busy || cooldown > 0}
      class="text-primary text-xs font-medium hover:underline disabled:opacity-50 disabled:no-underline"
      data-testid="email-verify-resend"
    >
      {#if cooldown > 0}
        Erneut in {cooldown}s
      {:else if busy}
        Senden…
      {:else}
        Email erneut senden
      {/if}
    </button>
    <button
      type="button"
      onclick={dismiss}
      class="text-text-muted hover:text-text-base rounded-md p-0.5 transition-colors"
      aria-label="Banner schließen"
      data-testid="email-verify-dismiss"
    >
      <XIcon class="size-4" />
    </button>
  </div>
{/if}
