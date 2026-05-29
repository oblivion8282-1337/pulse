<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { toast } from 'svelte-sonner';
  import { login, loginWithTotp, me, isMfaChallenge, type MfaMethod } from '$lib/api/auth';
  import { loginWithPasskey, webauthnSupported } from '$lib/api/webauthn';
  import { ApiError } from '$lib/api/client';
  import { auth } from '$lib/stores/auth.svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import * as Alert from '$lib/components/ui/alert/index.js';
  import OctagonXIcon from '@lucide/svelte/icons/octagon-x';
  import FingerprintIcon from '@lucide/svelte/icons/fingerprint';
  import AuthBrandPanel from '$lib/components/AuthBrandPanel.svelte';
  import LoginMfaForm from '$lib/components/auth/LoginMfaForm.svelte';
  import { runIssueFlow, RecoveryAvailableError } from '$lib/identity/issue-flow';
  import { startProfileRefresh } from '$lib/identity/profile-refresh.svelte';
  import { startCertRotation } from '$lib/identity/cert-rotation.svelte';
  import { isElectron } from '$lib/platform/runtime';

  type Step = 'credentials' | 'mfa';

  let emailOrUsername = $state('');
  let password = $state('');
  let error = $state<string | null>(null);
  let busy = $state(false);
  let step = $state<Step>('credentials');
  let mfaTicket = $state<string | null>(null);
  let mfaMethods = $state<MfaMethod[]>([]);

  // WebAuthn API presence is fixed for the page's lifetime — `ssr=false`, so
  // `window` is always there by the time this runs. Passkeys are only offered
  // in the browser: inside the desktop shell a browser-stored passkey is
  // unreachable (Electron's Chromium is a separate credential store with no
  // Linux platform authenticator), so the button would always dead-end. The
  // reliable desktop path is password + TOTP / backup code (see LoginMfaForm).
  const passkeysAvailable = webauthnSupported() && !isElectron();

  /** Surface the raw ceremony error. Passkey login is offered in the browser
   *  only, so no desktop-specific fallback hint is needed here. */
  function passkeyError(err: unknown): string {
    return err instanceof Error ? err.message : 'Passkey-Anmeldung fehlgeschlagen.';
  }

  function safeRedirect(raw: string | null): string {
    if (!raw) return '/app';
    // Must start with "/" but not "//" — prevents open-redirect via //evil.com
    if (raw.startsWith('/') && !raw.startsWith('//')) return raw;
    return '/app';
  }

  onMount(() => {
    if (page.url.searchParams.get('reset') === '1') {
      toast.success('Passwort zurückgesetzt — bitte einloggen.');
    }
    if (page.url.searchParams.get('verified') === '1') {
      toast.success('Email bestätigt.');
    }
    // Big-Bang-Migration auf Cert-Modell: alle Refresh-Tokens wurden beim
    // Deploy revoked (Migration 0018). doRefresh() in client.ts setzt diesen
    // Key wenn ein Refresh mit 401 scheitert. Klare Meldung statt stummem
    // Logout überrascht den User nicht.
    if (sessionStorage.getItem('pulse.session_expired') === '1') {
      sessionStorage.removeItem('pulse.session_expired');
      toast.info('Pulse wurde aktualisiert — bitte einmal neu einloggen.', {
        duration: 8000
      });
    }
  });

  async function completeLogin() {
    auth.setUser(await me());

    // Identity-Flow: Cert ausstellen + Profile-Statement holen. Blockierend
    // weil bei RecoveryAvailableError ein Redirect zu /recover gemacht
    // werden muss, statt direkt nach /app zu gehen. Andere Fehler werden
    // weiterhin geschluckt (Cert-Features degradieren gracefully).
    try {
      await runIssueFlow();
      if (auth.isAuthenticated) {
        void startProfileRefresh();
        void startCertRotation();
      }
    } catch (err) {
      if (err instanceof RecoveryAvailableError) {
        const params = new URLSearchParams({
          cert_id: err.certId,
          device_label: err.deviceLabel,
        });
        await goto(`/recover?${params.toString()}`, { replaceState: true });
        return;
      }
      console.warn('[identity] issue-flow fehlgeschlagen:', err);
    }

    const redirect = safeRedirect(page.url.searchParams.get('redirect'));
    await goto(redirect);
  }

  async function submit(e: Event) {
    e.preventDefault();
    error = null;
    busy = true;
    try {
      const result = await login(emailOrUsername.trim(), password);
      if (isMfaChallenge(result)) {
        mfaTicket = result.mfa_ticket;
        mfaMethods = result.methods;
        step = 'mfa';
        return;
      }
      await completeLogin();
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }

  /** Passwordless login from the credentials step — a discoverable passkey
   *  identifies the user, no email/password typed. */
  async function passwordlessLogin() {
    if (busy) return;
    error = null;
    busy = true;
    try {
      await loginWithPasskey();
      await completeLogin();
    } catch (err) {
      error = passkeyError(err);
    } finally {
      busy = false;
    }
  }

  /** Passkey as the 2FA second factor — uses the ticket from the password
   *  step. Same expired-ticket reset as `submitTotp`. */
  async function submitPasskeyMfa() {
    if (!mfaTicket || busy) return;
    error = null;
    busy = true;
    try {
      await loginWithPasskey(mfaTicket);
      await completeLogin();
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 410)) {
        mfaTicket = null;
        step = 'credentials';
        error = 'Anmeldung abgelaufen — bitte erneut einloggen.';
      } else {
        error = passkeyError(err);
      }
    } finally {
      busy = false;
    }
  }

  /** Called from the TOTP sub-form with whichever code variant the user
   *  filled in. Resets back to the credentials step on a clearly-expired
   *  ticket (401/410) so the user can re-enter the password. */
  async function submitTotp(args: { code?: string; backup_code?: string }) {
    if (!mfaTicket || busy) return;
    error = null;
    busy = true;
    try {
      await loginWithTotp(mfaTicket, args);
      await completeLogin();
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 410)) {
        mfaTicket = null;
        step = 'credentials';
        error = 'Anmeldung abgelaufen — bitte erneut einloggen.';
      } else {
        error = (err as Error).message;
      }
    } finally {
      busy = false;
    }
  }

  function cancelMfa() {
    step = 'credentials';
    mfaTicket = null;
    mfaMethods = [];
    error = null;
  }
</script>

<div class="flex min-h-dvh">
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
    {#if step === 'credentials'}
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
          <Label
            for="login-identifier"
            class="text-muted-foreground text-xs font-semibold uppercase tracking-wide"
          >
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
          <div class="flex items-baseline justify-between gap-2">
            <Label
              for="login-password"
              class="text-muted-foreground text-xs font-semibold uppercase tracking-wide"
            >
              Passwort
            </Label>
            <a
              class="text-primary text-xs hover:underline"
              href="/forgot-password"
              data-testid="login-forgot"
            >
              Passwort vergessen?
            </a>
          </div>
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

        {#if passkeysAvailable}
          <div class="text-muted-foreground flex items-center gap-3 text-xs">
            <span class="bg-border h-px flex-1"></span>
            oder
            <span class="bg-border h-px flex-1"></span>
          </div>
          <Button
            type="button"
            variant="secondary"
            class="w-full gap-2"
            disabled={busy}
            onclick={passwordlessLogin}
            data-testid="login-passkey"
          >
            <FingerprintIcon class="size-4" />
            Mit Passkey anmelden
          </Button>
        {/if}

        <p class="text-muted-foreground text-center text-sm">
          Brauchst du ein Konto?
          <a class="text-primary hover:underline" href="/register">Registrieren</a>
        </p>
      </form>
    {:else}
      <LoginMfaForm
        methods={mfaMethods}
        {busy}
        {error}
        onTotp={submitTotp}
        onPasskey={submitPasskeyMfa}
        onCancel={cancelMfa}
      />
    {/if}
  </div>
</div>
