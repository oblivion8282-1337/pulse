<script lang="ts">
  import { goto } from '$app/navigation';
  import { register, me } from '$lib/api/auth';
  import { auth } from '$lib/stores/auth.svelte';
  import { ApiError } from '$lib/api/client';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import * as Alert from '$lib/components/ui/alert/index.js';
  import OctagonXIcon from '@lucide/svelte/icons/octagon-x';
  import AuthBrandPanel from '$lib/components/AuthBrandPanel.svelte';

  let username = $state('');
  let email = $state('');
  let password = $state('');
  let displayName = $state('');
  let error = $state<string | null>(null);
  let suggestions = $state<string[]>([]);
  let busy = $state(false);

  async function submit(e: Event) {
    e.preventDefault();
    error = null;
    suggestions = [];
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
      // Surface the structured 409 bodies the backend now sends:
      //   { detail: { error: "username_taken", suggestions: [...] } }
      //   { detail: { error: "email_taken" } }
      // Everything else falls back to the generic message.
      if (err instanceof ApiError && err.status === 409) {
        const body = err.body as { detail?: { error?: string; suggestions?: string[] } } | null;
        const d = body?.detail;
        if (d?.error === 'username_taken') {
          error = 'Dieser Benutzername ist schon vergeben.';
          suggestions = Array.isArray(d.suggestions) ? d.suggestions : [];
        } else if (d?.error === 'email_taken') {
          error = 'Diese E-Mail ist bereits registriert.';
        } else {
          error = (err as Error).message;
        }
      } else {
        error = (err as Error).message;
      }
    } finally {
      busy = false;
    }
  }

  function pickSuggestion(s: string) {
    username = s;
    error = null;
    suggestions = [];
  }
</script>

<div class="flex min-h-dvh">
  <AuthBrandPanel
    headline="Werd Teil von Pulse."
    description="In 30 Sekunden eingerichtet. Erstell einen Server, lade Freunde ein, starte einen Voice-Channel."
    features={[
      'Kostenlos, keine Karte nötig',
      'Argon2id-Passwörter, RS256-Tokens',
      'Sofort einsatzbereit auf jedem Gerät',
    ]}
  />

  <!-- Formular-Pane: auf Mobil volle Breite + zentriert; ab md: fixe 46 % -->
  <div class="flex flex-1 items-center justify-center p-4 md:flex-none md:basis-[46%]">
    <form
      class="bg-card w-full max-w-md space-y-4 rounded-xl p-8 shadow-2xl"
      onsubmit={submit}
      aria-label="register form"
    >
      <header class="space-y-2 text-center">
        <img src="/pulse-mark.svg" alt="Pulse" width="56" height="56" class="mx-auto size-14" />
        <h1 class="text-card-foreground text-2xl font-semibold">Konto erstellen</h1>
      </header>

      <div class="space-y-1.5">
        <Label for="reg-username" class="text-muted-foreground text-xs font-semibold uppercase tracking-wide">
          Benutzername
        </Label>
        <Input
          id="reg-username"
          type="text"
          bind:value={username}
          required
          minlength={3}
          maxlength={32}
          pattern="[A-Za-z0-9_.\-]+"
          data-testid="reg-username"
        />
      </div>

      <div class="space-y-1.5">
        <Label for="reg-email" class="text-muted-foreground text-xs font-semibold uppercase tracking-wide">
          E-Mail
        </Label>
        <Input
          id="reg-email"
          type="email"
          autocomplete="email"
          bind:value={email}
          required
          data-testid="reg-email"
        />
      </div>

      <div class="space-y-1.5">
        <Label for="reg-display" class="text-muted-foreground text-xs font-semibold uppercase tracking-wide">
          Anzeigename (optional)
        </Label>
        <Input id="reg-display" type="text" bind:value={displayName} maxlength={64} data-testid="reg-display" />
      </div>

      <div class="space-y-1.5">
        <Label for="reg-password" class="text-muted-foreground text-xs font-semibold uppercase tracking-wide">
          Passwort
        </Label>
        <Input
          id="reg-password"
          type="password"
          autocomplete="new-password"
          bind:value={password}
          required
          minlength={8}
          data-testid="reg-password"
        />
      </div>

      {#if error}
        <Alert.Root variant="destructive" data-testid="reg-error">
          <OctagonXIcon />
          <Alert.Description>
            {error}
            {#if suggestions.length > 0}
              <div class="mt-2 flex flex-wrap gap-2" data-testid="reg-suggestions">
                <span class="text-sm">Vorschläge:</span>
                {#each suggestions as s (s)}
                  <button
                    type="button"
                    class="rounded-md border border-current/40 bg-card/60 px-2 py-0.5 text-sm font-medium hover:bg-card"
                    onclick={() => pickSuggestion(s)}
                    data-testid="reg-suggestion"
                  >
                    {s}
                  </button>
                {/each}
              </div>
            {/if}
          </Alert.Description>
        </Alert.Root>
      {/if}

      <Button type="submit" class="w-full" disabled={busy} data-testid="reg-submit">
        {busy ? 'Registrieren…' : 'Konto erstellen'}
      </Button>

      <p class="text-muted-foreground text-center text-sm">
        Schon ein Konto?
        <a class="text-primary hover:underline" href="/login">Anmelden</a>
      </p>
    </form>
  </div>
</div>
