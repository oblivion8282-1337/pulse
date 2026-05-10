<script lang="ts">
  import { goto } from '$app/navigation';
  import { login } from '$lib/api/auth';
  import { auth } from '$lib/stores/auth.svelte';
  import { me } from '$lib/api/auth';

  let emailOrUsername = $state('');
  let password = $state('');
  let error = $state<string | null>(null);
  let busy = $state(false);

  async function submit(e: Event) {
    e.preventDefault();
    error = null;
    busy = true;
    try {
      await login(emailOrUsername.trim(), password);
      auth.setUser(await me());
      await goto('/app');
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<div class="flex min-h-screen items-center justify-center p-4">
  <form
    class="w-full max-w-md space-y-4 rounded-xl bg-[var(--color-bg-channels)] p-8 shadow-2xl"
    onsubmit={submit}
    aria-label="login form"
  >
    <header class="space-y-1 text-center">
      <h1 class="text-2xl font-semibold text-[var(--color-text-bright)]">Willkommen zurück!</h1>
      <p class="text-sm text-[var(--color-text-muted)]">
        Wir freuen uns, dich wiederzusehen!
      </p>
    </header>

    <label class="block">
      <span class="mb-1 block text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
        E-Mail oder Benutzername
      </span>
      <input
        type="text"
        autocomplete="username"
        bind:value={emailOrUsername}
        class="input-base"
        required
        data-testid="login-identifier"
      />
    </label>

    <label class="block">
      <span class="mb-1 block text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
        Passwort
      </span>
      <input
        type="password"
        autocomplete="current-password"
        bind:value={password}
        class="input-base"
        required
        data-testid="login-password"
      />
    </label>

    {#if error}
      <p class="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-400" data-testid="login-error">
        {error}
      </p>
    {/if}

    <button
      type="submit"
      class="btn-primary w-full"
      disabled={busy}
      data-testid="login-submit"
    >
      {busy ? 'Anmelden…' : 'Anmelden'}
    </button>

    <p class="text-center text-sm text-[var(--color-text-muted)]">
      Brauchst du ein Konto?
      <a class="text-[var(--color-accent)] hover:underline" href="/register">Registrieren</a>
    </p>
  </form>
</div>
