<script lang="ts">
  /**
   * "Passwort ändern"-Block im Sicherheits-Tab.
   *
   * Authenticated change: aktuelles Passwort als Re-Auth-Gate + neues (2×).
   * Bei Erfolg loggt der Server alle ANDEREN Geräte aus und liefert ein
   * frisches Token-Paar für dieses Gerät zurück (in `changePassword` persistiert),
   * sodass die aktive Session weiterläuft.
   */
  import { toast } from 'svelte-sonner';
  import KeyRoundIcon from '@lucide/svelte/icons/key-round';
  import { changePassword } from '$lib/api/auth';
  import { ApiError } from '$lib/api/client';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import FieldLabel from '$lib/components/form/FieldLabel.svelte';
  import * as Alert from '$lib/components/ui/alert/index.js';
  import OctagonXIcon from '@lucide/svelte/icons/octagon-x';
  import { m } from '$lib/paraglide/messages.js';

  let current = $state('');
  let next = $state('');
  let confirm = $state('');
  let error = $state<string | null>(null);
  let busy = $state(false);

  async function submit(e: Event) {
    e.preventDefault();
    error = null;
    if (next.length < 8) {
      error = m.change_password_error_too_short();
      return;
    }
    if (next !== confirm) {
      error = m.change_password_error_mismatch();
      return;
    }
    if (next === current) {
      error = m.change_password_error_same();
      return;
    }
    busy = true;
    try {
      await changePassword(current, next);
      current = '';
      next = '';
      confirm = '';
      toast.success(m.change_password_success());
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) {
        error = m.change_password_error_current_wrong();
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
  data-testid="change-password-section"
>
  <div class="flex items-start gap-3">
    <span class="bg-bg-input text-text-muted flex size-9 items-center justify-center rounded-full">
      <KeyRoundIcon class="size-5" />
    </span>
    <div class="flex flex-col gap-0.5">
      <span class="text-text-bright text-sm font-medium">{m.change_password_title()}</span>
      <span class="text-text-muted text-xs">{m.change_password_description()}</span>
    </div>
  </div>

  <form class="flex flex-col gap-3" onsubmit={submit}>
    <div class="space-y-1.5">
      <FieldLabel for="cp-current" required class="text-text-muted text-xs font-semibold uppercase tracking-wide">
        {m.change_password_current_label()}
      </FieldLabel>
      <Input
        id="cp-current"
        type="password"
        autocomplete="current-password"
        bind:value={current}
        required
        data-testid="change-password-current"
      />
    </div>

    <div class="space-y-1.5">
      <FieldLabel for="cp-new" required class="text-text-muted text-xs font-semibold uppercase tracking-wide">
        {m.change_password_new_label()}
      </FieldLabel>
      <Input
        id="cp-new"
        type="password"
        autocomplete="new-password"
        bind:value={next}
        required
        minlength={8}
        data-testid="change-password-new"
      />
    </div>

    <div class="space-y-1.5">
      <FieldLabel for="cp-confirm" required class="text-text-muted text-xs font-semibold uppercase tracking-wide">
        {m.change_password_confirm_label()}
      </FieldLabel>
      <Input
        id="cp-confirm"
        type="password"
        autocomplete="new-password"
        bind:value={confirm}
        required
        minlength={8}
        data-testid="change-password-confirm"
      />
    </div>

    {#if error}
      <Alert.Root variant="destructive" data-testid="change-password-error">
        <OctagonXIcon />
        <Alert.Description>{error}</Alert.Description>
      </Alert.Root>
    {/if}

    <Button
      type="submit"
      class="self-start"
      disabled={busy}
      data-testid="change-password-submit"
    >
      {busy ? m.change_password_submitting() : m.change_password_submit()}
    </Button>
  </form>
</section>
