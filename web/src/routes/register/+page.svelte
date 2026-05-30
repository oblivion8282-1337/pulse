<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { register, me } from '$lib/api/auth';
  import { auth } from '$lib/stores/auth.svelte';
  import { ApiError } from '$lib/api/client';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import * as Alert from '$lib/components/ui/alert/index.js';
  import OctagonXIcon from '@lucide/svelte/icons/octagon-x';
  import AuthBrandPanel from '$lib/components/AuthBrandPanel.svelte';
  import LegalFooter from '$lib/components/LegalFooter.svelte';
  import { runIssueFlow } from '$lib/identity/issue-flow';
  import { startProfileRefresh } from '$lib/identity/profile-refresh.svelte';
  import { startCertRotation } from '$lib/identity/cert-rotation.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let username = $state('');
  let email = $state('');
  let password = $state('');
  let displayName = $state('');
  let error = $state<string | null>(null);
  let suggestions = $state<string[]>([]);
  let busy = $state(false);

  // Invite code: prefilled from a shared ``/register?invite=CODE`` link, and
  // otherwise revealed only when the backend reports the server is invite-only
  // (so open instances keep the form clean).
  let inviteCode = $state(page.url.searchParams.get('invite') ?? '');
  let showInvite = $state(!!page.url.searchParams.get('invite'));

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
        display_name: displayName.trim() || null,
        invite_code: inviteCode.trim() || null
      });
      auth.setUser(await me());

      // Identity-Flow: Cert + Profile-Statement ausstellen + Refresh-Timer
      // starten. Bei frischer Registration kann **per Definition** kein
      // Recovery-Backup existieren (User wurde gerade erst angelegt) — wir
      // brauchen den RecoveryAvailableError-Catch hier nicht und können
      // fire-and-forget machen wie der Login es ursprünglich tat. Sonst
      // blockiert das ``await`` die Navigation und der Onboarding-Dialog
      // pop't synchron in Playwright-Tests vor der ersten User-Aktion auf
      // (StatusPicker/Settings-Button werden vom Dialog-Overlay verdeckt).
      void runIssueFlow()
        .then(() => {
          if (auth.isAuthenticated) {
            void startProfileRefresh();
            void startCertRotation();
          }
        })
        .catch((err: unknown) => {
          console.warn('[identity] issue-flow fehlgeschlagen:', err);
        });

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
          error = m.register_error_username_taken();
          suggestions = Array.isArray(d.suggestions) ? d.suggestions : [];
        } else if (d?.error === 'email_taken') {
          error = m.register_error_email_taken();
        } else {
          error = (err as Error).message;
        }
      } else if (err instanceof ApiError && err.status === 403) {
        // Registration gate (auth-svc sends a plain-string detail).
        const detail = String((err.body as { detail?: string } | null)?.detail ?? '');
        if (detail.includes('invite code required')) {
          showInvite = true;
          error = m.register_error_invite_required();
        } else if (detail.includes('invite')) {
          showInvite = true;
          error = m.register_error_invite_invalid();
        } else if (detail.includes('local registration disabled')) {
          error = m.register_error_local_disabled();
        } else if (detail.includes('closed')) {
          error = m.register_error_closed();
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

<div class="relative flex min-h-dvh">
  <AuthBrandPanel
    headline={m.register_brand_headline()}
    description={m.register_brand_description()}
    features={[
      m.register_brand_feature_free(),
      m.register_brand_feature_security(),
      m.register_brand_feature_ready(),
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
        <h1 class="text-card-foreground text-2xl font-semibold">{m.register_heading()}</h1>
      </header>

      <div class="space-y-1.5">
        <Label for="reg-username" class="text-muted-foreground text-xs font-semibold uppercase tracking-wide">
          {m.register_label_username()}
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
          {m.register_label_email()}
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
          {m.register_label_display_name()}
        </Label>
        <Input id="reg-display" type="text" bind:value={displayName} maxlength={64} data-testid="reg-display" />
      </div>

      {#if showInvite}
        <div class="space-y-1.5">
          <Label for="reg-invite" class="text-muted-foreground text-xs font-semibold uppercase tracking-wide">
            {m.register_label_invite_code()}
          </Label>
          <Input
            id="reg-invite"
            type="text"
            bind:value={inviteCode}
            maxlength={64}
            autocomplete="off"
            data-testid="reg-invite"
          />
        </div>
      {/if}

      <div class="space-y-1.5">
        <Label for="reg-password" class="text-muted-foreground text-xs font-semibold uppercase tracking-wide">
          {m.register_label_password()}
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
                <span class="text-sm">{m.register_suggestions_label()}</span>
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
        {busy ? m.register_submit_busy() : m.register_submit_idle()}
      </Button>

      <p class="text-muted-foreground text-center text-sm">
        {m.register_have_account()}
        <a class="text-primary hover:underline" href="/login">{m.register_sign_in_link()}</a>
      </p>
    </form>
  </div>

  <!-- Dezente Rechts-Buttons am unteren Fensterrand. -->
  <div class="absolute inset-x-0 bottom-0 z-30 flex justify-center p-4">
    <LegalFooter />
  </div>
</div>
