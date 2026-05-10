<script lang="ts">
  import { goto } from '$app/navigation';
  import { register, me } from '$lib/api/auth';
  import { auth } from '$lib/stores/auth.svelte';

  let username = $state('');
  let email = $state('');
  let password = $state('');
  let displayName = $state('');
  let error = $state<string | null>(null);
  let busy = $state(false);

  async function submit(e: Event) {
    e.preventDefault();
    error = null;
    busy = true;
    try {
      await register({
        username: username.trim(),
        email: email.trim().toLowerCase(),
        password,
        display_name: displayName.trim() || null
      });
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
    aria-label="register form"
  >
    <header class="space-y-1 text-center">
      <h1 class="text-2xl font-semibold text-[var(--color-text-bright)]">Konto erstellen</h1>
    </header>

    <label class="block">
      <span class="mb-1 block text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
        Benutzername
      </span>
      <input
        type="text"
        bind:value={username}
        class="input-base"
        required
        minlength="3"
        maxlength="32"
        pattern="[A-Za-z0-9_.\-]+"
        data-testid="reg-username"
      />
    </label>

    <label class="block">
      <span class="mb-1 block text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
        E-Mail
      </span>
      <input
        type="email"
        autocomplete="email"
        bind:value={email}
        class="input-base"
        required
        data-testid="reg-email"
      />
    </label>

    <label class="block">
      <span class="mb-1 block text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
        Anzeigename (optional)
      </span>
      <input
        type="text"
        bind:value={displayName}
        class="input-base"
        maxlength="64"
        data-testid="reg-display"
      />
    </label>

    <label class="block">
      <span class="mb-1 block text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
        Passwort
      </span>
      <input
        type="password"
        autocomplete="new-password"
        bind:value={password}
        class="input-base"
        required
        minlength="8"
        data-testid="reg-password"
      />
    </label>

    {#if error}
      <p class="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-400" data-testid="reg-error">
        {error}
      </p>
    {/if}

    <button
      type="submit"
      class="btn-primary w-full"
      disabled={busy}
      data-testid="reg-submit"
    >
      {busy ? 'Registrieren…' : 'Konto erstellen'}
    </button>

    <p class="text-center text-sm text-[var(--color-text-muted)]">
      Schon ein Konto?
      <a class="text-[var(--color-accent)] hover:underline" href="/login">Anmelden</a>
    </p>
  </form>
</div>
