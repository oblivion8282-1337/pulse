<script lang="ts">
  /**
   * "E-Mail-Adresse"-Block im Sicherheits-Tab.
   *
   * Zeigt die aktuelle Adresse + Formular zum Ändern (neue Adresse + aktuelles
   * Passwort als Re-Auth-Gate). Der Server schickt einen Bestätigungslink an die
   * NEUE Adresse; erst nach Klick wird gewechselt (siehe verify-email-change).
   */
  import { toast } from 'svelte-sonner';
  import MailIcon from '@lucide/svelte/icons/mail';
  import { changeEmail } from '$lib/api/auth';
  import { ApiError } from '$lib/api/client';
  import { auth } from '$lib/stores/auth.svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import * as Alert from '$lib/components/ui/alert/index.js';
  import OctagonXIcon from '@lucide/svelte/icons/octagon-x';
  import { m } from '$lib/paraglide/messages.js';

  let newEmail = $state('');
  let password = $state('');
  let error = $state<string | null>(null);
  let busy = $state(false);
  let sent = $state(false);

  const currentEmail = $derived(auth.user?.email ?? '');

  async function submit(e: Event) {
    e.preventDefault();
    error = null;
    const candidate = newEmail.trim();
    if (!candidate || !candidate.includes('@')) {
      error = m.change_email_error_invalid();
      return;
    }
    if (candidate.toLowerCase() === currentEmail.toLowerCase()) {
      error = m.change_email_error_unchanged();
      return;
    }
    busy = true;
    try {
      await changeEmail(candidate, password);
      sent = true;
      password = '';
      toast.success(m.change_email_success());
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        error = m.change_email_error_in_use();
      } else if (err instanceof ApiError && err.status === 400) {
        error = m.change_email_error_password_wrong();
      } else {
        error = (err as Error).message;
      }
    } finally {
      busy = false;
    }
  }
</script>

<section
  class="border-border bg-bg-input/40 flex flex-col gap-3 rounded-2xl border p-4"
  data-testid="change-email-section"
>
  <div class="flex items-start gap-3">
    <span class="bg-bg-input text-text-muted flex size-9 items-center justify-center rounded-full">
      <MailIcon class="size-5" />
    </span>
    <div class="flex flex-col gap-0.5">
      <span class="text-text-bright text-sm font-medium">{m.change_email_title()}</span>
      <span class="text-text-muted text-xs">
        {m.change_email_current_prefix()}
        <span class="text-text-base font-medium">{currentEmail}</span>
      </span>
    </div>
  </div>

  {#if sent}
    <p class="text-text-muted text-xs" data-testid="change-email-sent">
      {m.change_email_sent_hint()}
    </p>
  {/if}

  <form class="flex flex-col gap-3" onsubmit={submit}>
    <div class="space-y-1.5">
      <Label for="ce-new" class="text-text-muted text-xs font-semibold uppercase tracking-wide">
        {m.change_email_new_label()}
      </Label>
      <Input
        id="ce-new"
        type="email"
        autocomplete="email"
        bind:value={newEmail}
        required
        data-testid="change-email-new"
      />
    </div>

    <div class="space-y-1.5">
      <Label for="ce-pw" class="text-text-muted text-xs font-semibold uppercase tracking-wide">
        {m.change_email_password_label()}
      </Label>
      <Input
        id="ce-pw"
        type="password"
        autocomplete="current-password"
        bind:value={password}
        required
        data-testid="change-email-password"
      />
    </div>

    {#if error}
      <Alert.Root variant="destructive" data-testid="change-email-error">
        <OctagonXIcon />
        <Alert.Description>{error}</Alert.Description>
      </Alert.Root>
    {/if}

    <Button
      type="submit"
      class="self-start"
      disabled={busy}
      data-testid="change-email-submit"
    >
      {busy ? m.change_email_submitting() : m.change_email_submit()}
    </Button>
  </form>
</section>
