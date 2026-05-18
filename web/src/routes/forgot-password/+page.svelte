<script lang="ts">
  import { passwordForgot } from '$lib/api/auth';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import * as Alert from '$lib/components/ui/alert/index.js';
  import OctagonXIcon from '@lucide/svelte/icons/octagon-x';
  import MailCheckIcon from '@lucide/svelte/icons/mail-check';
  import AuthBrandPanel from '$lib/components/AuthBrandPanel.svelte';

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

<div class="flex min-h-dvh">
  <AuthBrandPanel
    headline="Schon mal passiert."
    headlineSub="Wir setzen dich zurück."
    description="Trag deine E-Mail oder deinen Benutzernamen ein — wenn das Konto bei uns liegt, kommt gleich ein Link."
    features={[
      'Link gilt 30 Minuten',
      'Funktioniert auch mit Benutzernamen',
      'Argon2id-Passwörter, niemals im Klartext gespeichert',
    ]}
  />

  <div class="flex flex-1 items-center justify-center p-4 md:flex-none md:basis-[46%]">
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
        <h1 class="text-card-foreground text-2xl font-semibold">Prüf dein Postfach</h1>
        <p class="text-muted-foreground text-sm">
          Falls die Adresse bei uns ist, ist eine Email auf dem Weg.
          Schau auch im Spam-Ordner nach.
        </p>
        <a
          class="text-primary inline-block text-sm hover:underline"
          href="/login"
          data-testid="forgot-back-to-login"
        >
          Zurück zum Login
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
          <h1 class="text-card-foreground text-2xl font-semibold">Passwort vergessen?</h1>
          <p class="text-muted-foreground text-sm">
            Wir schicken dir einen Link zum Zurücksetzen.
          </p>
        </header>

        <div class="space-y-1.5">
          <Label
            for="forgot-identifier"
            class="text-muted-foreground text-xs font-semibold uppercase tracking-wide"
          >
            E-Mail oder Benutzername
          </Label>
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
          {busy ? 'Senden…' : 'Link senden'}
        </Button>

        <p class="text-muted-foreground text-center text-sm">
          <a class="text-primary hover:underline" href="/login">Zurück zum Login</a>
        </p>
      </form>
    {/if}
  </div>
</div>
