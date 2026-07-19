<script lang="ts">
  /**
   * Geräte-Verwaltung: listet alle aktiven Identitäts-Certs des Users
   * und erlaubt das Abmelden einzelner Geräte via Cert-Revocation.
   *
   * "Aktuelles Gerät" wird über den lokalen Cert-Store erkannt
   * (certStore.cert?.claims.cert_id === device.cert_id).
   */
  import { onMount } from 'svelte';
  import { toast } from 'svelte-sonner';
  import MonitorIcon from '@lucide/svelte/icons/monitor';
  import SmartphoneIcon from '@lucide/svelte/icons/smartphone';
  import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';
  import { listCerts, revokeCert } from '$lib/api/credentials';
  import type { CredentialDevice } from '$lib/api/credentials';
  import { certStore } from '$lib/identity/cert.svelte';
  import { formatRelative } from '$lib/utils/formatRelative';
  import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { m } from '$lib/paraglide/messages.js';
  import EmptyState from '$lib/components/feedback/EmptyState.svelte';
  import LoadingState from '$lib/components/feedback/LoadingState.svelte';

  let devices = $state<CredentialDevice[]>([]);
  let loading = $state(true);
  let revokingId = $state<string | null>(null);
  let confirmDevice = $state<CredentialDevice | null>(null);
  let dialogOpen = $state(false);

  // confirmDevice ist die Quelle der Wahrheit. (Die alte 3-Zweig-Variante hatte
  // ZWEI Zweige mit IDENTISCHER Bedingung `confirmDevice !== null && !dialogOpen` —
  // der erste setzte confirmDevice=null, bevor der zweite den Dialog öffnen konnte
  // → der Bestätigungs-Dialog ging beim Klick NIE auf.)
  // Effekt 1: Auswahl steuert den Dialog (öffnet bei Auswahl, schließt beim
  // programmatischen Zurücksetzen nach erfolgreichem Revoke).
  $effect(() => {
    dialogOpen = confirmDevice !== null;
  });
  // Effekt 2: schließt bits-ui den Dialog (Escape/Backdrop/Abbrechen), Auswahl
  // zurücksetzen. Kein Loop: Effekt 1 liest nur confirmDevice, Effekt 2 nur
  // dialogOpen — das Schließen triggert Effekt 1 nicht erneut.
  $effect(() => {
    if (!dialogOpen) confirmDevice = null;
  });

  const currentCertId = $derived(certStore.cert?.claims.cert_id ?? null);

  function isCurrentDevice(device: CredentialDevice): boolean {
    return currentCertId !== null && device.cert_id === currentCertId;
  }

  function formatDate(iso: string): string {
    try {
      return new Intl.DateTimeFormat('de-DE', {
        dateStyle: 'medium',
        timeStyle: 'short'
      }).format(new Date(iso));
    } catch {
      return iso;
    }
  }

  function isExpiringSoon(device: CredentialDevice): boolean {
    const expiryMs = new Date(device.expires_at).getTime();
    const nowMs = Date.now();
    const thirtyDaysMs = 30 * 24 * 3600 * 1000;
    return expiryMs - nowMs < thirtyDaysMs;
  }

  function isMobile(label: string): boolean {
    return /android|ios|iphone|ipad|mobile/i.test(label);
  }

  async function load() {
    loading = true;
    try {
      const resp = await listCerts();
      devices = resp.devices;
    } catch (err) {
      toast.error(m.device_management_load_failed(), {
        description: (err as Error).message
      });
    } finally {
      loading = false;
    }
  }

  onMount(load);

  async function handleRevoke(device: CredentialDevice) {
    if (revokingId) return;
    revokingId = device.cert_id;
    confirmDevice = null;
    try {
      await revokeCert(device.cert_id);
      devices = devices.filter((d) => d.cert_id !== device.cert_id);
      if (isCurrentDevice(device)) {
        toast.success(m.device_management_current_device_revoked());
        // Cert aus Store wischen — nächste Aktion triggert Re-Issue
        await certStore.wipe();
      } else {
        toast.success(m.device_management_device_revoked({ label: device.device_label }));
      }
    } catch (err) {
      toast.error(m.device_management_revoke_failed(), {
        description: (err as Error).message
      });
      void load();
    } finally {
      revokingId = null;
    }
  }
</script>

<section
  class="border-border bg-bg-input/40 flex flex-col gap-3 rounded-2xl border p-4"
  data-testid="device-management-section"
>
  <div class="flex flex-col gap-1">
    <h3 class="text-text-bright text-sm font-semibold">{m.device_management_title()}</h3>
    <p class="text-text-muted text-xs">
      {m.device_management_description()}
    </p>
  </div>

  {#if loading}
    <LoadingState label={m.device_management_loading()} />
  {:else if devices.length === 0}
    <EmptyState message={m.device_management_empty()} />
  {:else}
    <ul class="flex flex-col gap-2" data-testid="device-list">
      {#each devices as device (device.cert_id)}
        {@const isCurrent = isCurrentDevice(device)}
        {@const expiringSoon = isExpiringSoon(device)}
        <li
          class="border-border bg-bg-base/40 flex flex-col gap-2 rounded-xl border p-3 sm:flex-row sm:items-center sm:justify-between"
          data-testid="device-row"
          data-cert-id={device.cert_id}
        >
          <div class="flex items-start gap-3 min-w-0">
            <span
              class="bg-bg-input text-text-muted mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full"
            >
              {#if isMobile(device.device_label)}
                <SmartphoneIcon class="size-4" />
              {:else}
                <MonitorIcon class="size-4" />
              {/if}
            </span>

            <div class="flex min-w-0 flex-col gap-0.5">
              <span class="text-text-bright truncate text-sm font-medium">
                {device.device_label}
                {#if isCurrent}
                  <span
                    class="ml-1 inline-flex items-center rounded bg-success/15 px-2 py-1 text-xs font-semibold uppercase tracking-wide text-success md:px-1.5 md:py-0.5 md:text-[10px]"
                    data-testid="device-current-badge"
                  >
                    {m.device_management_current_badge()}
                  </span>
                {/if}
              </span>

              <span class="text-text-muted text-xs">
                {m.device_management_issued_expires({ issued: formatDate(device.issued_at), expires: formatRelative(device.expires_at) })}
              </span>

              {#if expiringSoon}
                <span
                  class="mt-0.5 inline-flex items-center gap-1 text-xs text-warning"
                  data-testid="device-expiry-warning"
                >
                  <ShieldAlertIcon class="size-3" />
                  {m.device_management_expiry_warning()}
                </span>
              {/if}
            </div>
          </div>

          <Button
            variant="destructive"
            size="xs"
            onclick={() => (confirmDevice = device)}
            disabled={revokingId === device.cert_id}
            class="self-start sm:self-auto"
            data-testid="device-revoke"
          >
            {revokingId === device.cert_id ? m.device_management_revoking() : m.device_management_revoke()}
          </Button>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<AlertDialog.Root bind:open={dialogOpen}>
  <AlertDialog.Content data-testid="device-revoke-dialog">
    <AlertDialog.Header>
      <AlertDialog.Title>{m.device_management_dialog_title()}</AlertDialog.Title>
      <AlertDialog.Description>
        {#if confirmDevice && isCurrentDevice(confirmDevice)}
          {m.device_management_dialog_body_current_pre()}<strong>{m.device_management_dialog_body_current_strong()}</strong>{m.device_management_dialog_body_current_post()}
        {:else}
          {m.device_management_dialog_body_other_pre()}<strong>{confirmDevice?.device_label ?? ''}</strong>{m.device_management_dialog_body_other_post()}
        {/if}
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel disabled={revokingId !== null}>{m.device_management_cancel()}</AlertDialog.Cancel>
      <Button
        variant="destructive"
        onclick={() => confirmDevice && handleRevoke(confirmDevice)}
        disabled={revokingId !== null}
        data-testid="device-revoke-confirm"
      >
        {revokingId !== null ? m.device_management_revoking() : m.device_management_revoke()}
      </Button>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
