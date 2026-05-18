<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { passwordReset } from '$lib/api/auth';
  import { ApiError } from '$lib/api/client';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import * as Alert from '$lib/components/ui/alert/index.js';
  import OctagonXIcon from '@lucide/svelte/icons/octagon-x';
  import AuthBrandPanel from '$lib/components/AuthBrandPanel.svelte';

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
      error = 'Passwort muss mindestens 8 Zeichen lang sein.';
      return;
    }
    if (password !== confirm) {
      error = 'Die Passwörter stimmen nicht überein.';
      return;
    }
    if (!token) {
      error = 'Kein gültiger Reset-Token in der URL.';
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
        error = 'Der Link ist abgelaufen oder bereits benutzt worden.';
      } else {
        error = (err as Error).message;
      }
    } finally {
      busy = false;
    }
  }
</script>

<div class="flex min-h-dvh">
  <AuthBrandPanel
    headline="Neuer Schlüssel."
    headlineSub="Gleicher Account."
    description="Wähl ein neues Passwort — wir hashen es mit Argon2id, kein Mensch und kein Server sieht das Klartext."
    features={['Mindestens 8 Zeichen', 'Argon2id (t=3, m=64 MiB)', 'Nach dem Reset gilt der Login sofort']}
  />

  <div class="flex flex-1 items-center justify-center p-4 md:flex-none md:basis-[46%]">
    <form
      class="bg-card w-full max-w-md space-y-4 rounded-xl p-8 shadow-2xl"
      onsubmit={submit}
      aria-label="reset password form"
    >
      <header class="space-y-2 text-center">
        <img src="/pulse-mark.svg" alt="Pulse" width="56" height="56" class="mx-auto size-14" />
        <h1 class="text-card-foreground text-2xl font-semibold">Neues Passwort wählen</h1>
      </header>

      <div class="space-y-1.5">
        <Label
          for="reset-password"
          class="text-muted-foreground text-xs font-semibold uppercase tracking-wide"
        >
          Neues Passwort
        </Label>
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
        <Label
          for="reset-confirm"
          class="text-muted-foreground text-xs font-semibold uppercase tracking-wide"
        >
          Passwort bestätigen
        </Label>
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
        {busy ? 'Speichern…' : 'Passwort speichern'}
      </Button>

      {#if tokenInvalid}
        <p class="text-muted-foreground text-center text-sm">
          <a
            class="text-primary hover:underline"
            href="/forgot-password"
            data-testid="reset-request-new"
          >
            Neuen Link anfordern
          </a>
        </p>
      {:else}
        <p class="text-muted-foreground text-center text-sm">
          <a class="text-primary hover:underline" href="/login">Zurück zum Login</a>
        </p>
      {/if}
    </form>
  </div>
</div>
