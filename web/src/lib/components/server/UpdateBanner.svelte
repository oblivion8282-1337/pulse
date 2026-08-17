<!--
  UpdateBanner — Phase 4.3.

  Slim Banner oben im App-Shell, sichtbar wenn die aktive Gateway-Connection
  einen "abnormalen" Zustand hat (incompatible/updating/starting/mfa-required/
  suspended/email-unverified). Reaktiv via `serverState` (1Hz-Poll, kein
  Eingriff in gateway-connection.ts). Bei `open` oder `idle` → unsichtbar.

  mfa-required hat einen Action-Button → /login (Cloud) bzw. Stub-Hinweis
  (Self-Host, Cert-Re-Auth ist Phase 5); email-unverified führt auf den
  Bestätigungs-Schirm. `suspended` bekommt bewusst KEINEN Knopf: der Nutzer
  kann nichts tun, die Verbindung kommt beim Aufheben von selbst zurück.
-->
<script lang="ts">
  import RefreshCcwIcon from '@lucide/svelte/icons/refresh-ccw';
  import AlertCircleIcon from '@lucide/svelte/icons/alert-circle';
  import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';
  import MailWarningIcon from '@lucide/svelte/icons/mail-warning';
  import { Button } from '$lib/components/ui/button/index.js';
  import { goto } from '$app/navigation';
  import { activeServer } from '$lib/stores/active-server.svelte';
  import { serverState } from '$lib/ws/server-state.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let active = $derived(activeServer.current);
  let snap = $derived(active ? serverState.get(active.id) : { state: 'idle' as const, helloMeta: null });
  let visible = $derived(
    snap.state === 'incompatible' ||
      snap.state === 'updating' ||
      snap.state === 'starting' ||
      snap.state === 'mfa-required' ||
      snap.state === 'suspended' ||
      snap.state === 'email-unverified',
  );
  let host = $derived(active?.label ?? 'Server');

  function message(state: string, h: string): string {
    if (state === 'incompatible')
      return m.update_banner_incompatible({ host: h });
    if (state === 'updating')
      return m.update_banner_updating({ host: h });
    if (state === 'starting')
      return m.update_banner_starting({ host: h });
    if (state === 'mfa-required')
      return m.update_banner_mfa_required({ host: h });
    if (state === 'suspended')
      return m.update_banner_suspended({ host: h });
    if (state === 'email-unverified')
      return m.update_banner_email_unverified({ host: h });
    return '';
  }

  function tone(state: string): string {
    if (
      state === 'mfa-required' ||
      state === 'suspended' ||
      state === 'email-unverified' ||
      state === 'incompatible'
    )
      return 'bg-destructive/15 border-destructive/40 text-destructive';
    return 'bg-warning/15 border-warning/40 text-warning';
  }
</script>

{#if visible}
  <div
    class="mx-3 mt-2 flex items-center gap-3 rounded-xl border px-3 py-2 text-sm {tone(snap.state)}"
    data-testid="update-banner"
    role="status"
  >
    {#if snap.state === 'mfa-required'}
      <ShieldAlertIcon class="size-4 shrink-0" />
    {:else if snap.state === 'email-unverified'}
      <MailWarningIcon class="size-4 shrink-0" />
    {:else if snap.state === 'suspended' || snap.state === 'incompatible'}
      <AlertCircleIcon class="size-4 shrink-0" />
    {:else}
      <RefreshCcwIcon class="size-4 shrink-0 animate-spin" />
    {/if}
    <span class="flex-1">{message(snap.state, host)}</span>
    {#if snap.state === 'mfa-required'}
      <Button
        size="sm"
        variant="outline"
        onclick={() => goto('/login')}
        data-testid="update-banner-mfa-action"
      >
        {m.update_banner_mfa_action()}
      </Button>
    {:else if snap.state === 'email-unverified'}
      <Button
        size="sm"
        variant="outline"
        onclick={() => goto('/verify-email-required')}
        data-testid="update-banner-email-action"
      >
        {m.update_banner_email_action()}
      </Button>
    {/if}
  </div>
{/if}
