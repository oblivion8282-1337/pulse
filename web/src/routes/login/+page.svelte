<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { login, me } from '$lib/api/auth';
  import { auth } from '$lib/stores/auth.svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import * as Alert from '$lib/components/ui/alert/index.js';
  import OctagonXIcon from '@lucide/svelte/icons/octagon-x';
  import AuthBrandPanel from '$lib/components/AuthBrandPanel.svelte';

  let emailOrUsername = $state('');
  let password = $state('');
  let error = $state<string | null>(null);
  let busy = $state(false);

  function safeRedirect(raw: string | null): string {
    if (!raw) return '/app';
    // Must start with "/" but not "//" — prevents open-redirect via //evil.com
    if (raw.startsWith('/') && !raw.startsWith('//')) return raw;
    return '/app';
  }

  async function submit(e: Event) {
    e.preventDefault();
    error = null;
    busy = true;
    try {
      await login(emailOrUsername.trim(), password);
      auth.setUser(await me());
      const redirect = safeRedirect(page.url.searchParams.get('redirect'));
      await goto(redirect);
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<div class="flex min-h-screen">
  <AuthBrandPanel
    headline="Bleib im Takt."
    headlineSub="Chat · Voice · HQ-Streams."
    description="Pulse läuft im Browser, als PWA und als Desktop-App — überall dieselbe Session, derselbe Stream."
    features={[
      'Kristallklarer Voice-Chat über LiveKit',
      'HQ-Screen-Streaming mit dem GPU Screen Recorder',
      'Web-first — kein Download nötig',
    ]}
  />

  <!-- Formular-Pane: auf Mobil volle Breite + zentriert; ab md: fixe 46 % -->
  <div class="flex flex-1 items-center justify-center p-4 md:flex-none md:basis-[46%]">
    <form
      class="bg-card w-full max-w-md space-y-4 rounded-xl p-8 shadow-2xl"
      onsubmit={submit}
      aria-label="login form"
    >
      <header class="space-y-2 text-center">
        <img src="/pulse-mark.svg" alt="Pulse" width="56" height="56" class="mx-auto size-14" />
        <h1 class="text-card-foreground text-2xl font-semibold">Willkommen zurück!</h1>
        <p class="text-muted-foreground text-sm">Wir freuen uns, dich wiederzusehen!</p>
      </header>

      <div class="space-y-1.5">
        <Label for="login-identifier" class="text-muted-foreground text-xs font-semibold uppercase tracking-wide">
          E-Mail oder Benutzername
        </Label>
        <Input
          id="login-identifier"
          type="text"
          autocomplete="username"
          bind:value={emailOrUsername}
          required
          data-testid="login-identifier"
        />
      </div>

      <div class="space-y-1.5">
        <Label for="login-password" class="text-muted-foreground text-xs font-semibold uppercase tracking-wide">
          Passwort
        </Label>
        <Input
          id="login-password"
          type="password"
          autocomplete="current-password"
          bind:value={password}
          required
          data-testid="login-password"
        />
      </div>

      {#if error}
        <Alert.Root variant="destructive" data-testid="login-error">
          <OctagonXIcon />
          <Alert.Description>{error}</Alert.Description>
        </Alert.Root>
      {/if}

      <Button type="submit" class="w-full" disabled={busy} data-testid="login-submit">
        {busy ? 'Anmelden…' : 'Anmelden'}
      </Button>

      <p class="text-muted-foreground text-center text-sm">
        Brauchst du ein Konto?
        <a class="text-primary hover:underline" href="/register">Registrieren</a>
      </p>
    </form>
  </div>
</div>
