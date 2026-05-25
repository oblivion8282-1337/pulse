<script lang="ts">
  /**
   * Geräte-Verwaltung: listet alle aktiven Identitäts-Certs des Users
   * und erlaubt das Abmelden einzelner Geräte via Cert-Revocation.
   *
   * "Aktuelles Gerät" wird über den lokalen Cert-Store erkannt
   * (certStore.cert?.claims.cert_id === device.cert_id).
   *
   * Backup-Status (Block 1.I / Block 2): wird als "Noch nicht implementiert"
   * angezeigt — Platzhalter für die Backup-Verschlüsselung.
   */
  import { onMount } from 'svelte';
  import { toast } from 'svelte-sonner';
  import MonitorIcon from '@lucide/svelte/icons/monitor';
  import SmartphoneIcon from '@lucide/svelte/icons/smartphone';
  import LoaderIcon from '@lucide/svelte/icons/loader-circle';
  import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';
  import { listCerts, revokeCert } from '$lib/api/credentials';
  import type { CredentialDevice } from '$lib/api/credentials';
  import { certStore } from '$lib/identity/cert.svelte';
  import { formatRelative } from '$lib/utils/formatRelative';
  import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';

  let devices = $state<CredentialDevice[]>([]);
  let loading = $state(true);
  let revokingId = $state<string | null>(null);
  let confirmDevice = $state<CredentialDevice | null>(null);
  let dialogOpen = $state(false);

  $effect(() => {
    // Synchronisiert dialogOpen mit confirmDevice.
    // Wenn bits-ui den Dialog schließt (Escape/Backdrop), müssen wir confirmDevice zurücksetzen.
    if (!dialogOpen && confirmDevice !== null) {
      confirmDevice = null;
    }
    if (confirmDevice !== null && !dialogOpen) {
      dialogOpen = true;
    }
    if (confirmDevice === null && dialogOpen) {
      dialogOpen = false;
    }
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
      toast.error('Geräteliste laden fehlgeschlagen', {
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
        toast.success('Dieses Gerät wurde abgemeldet.');
        // Cert aus Store wischen — nächste Aktion triggert Re-Issue
        await certStore.wipe();
      } else {
        toast.success(`"${device.device_label}" abgemeldet`);
      }
    } catch (err) {
      toast.error('Abmelden fehlgeschlagen', {
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
    <h3 class="text-text-bright text-sm font-semibold">Erkannte Geräte</h3>
    <p class="text-text-muted text-xs">
      Geräte mit einem aktiven Identitäts-Cert. Unbekannte Geräte sofort abmelden.
    </p>
  </div>

  {#if loading}
    <div class="text-text-muted flex items-center gap-2 text-xs">
      <LoaderIcon class="size-4 animate-spin" />
      <span>Geräte werden geladen…</span>
    </div>
  {:else if devices.length === 0}
    <div class="text-text-muted text-xs">Keine aktiven Geräte-Certs gefunden.</div>
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
                    class="ml-1 inline-flex items-center rounded bg-emerald-500/15 px-2 py-1 text-xs font-semibold uppercase tracking-wide text-emerald-500 md:px-1.5 md:py-0.5 md:text-[10px]"
                    data-testid="device-current-badge"
                  >
                    Dieses Gerät
                  </span>
                {/if}
              </span>

              <span class="text-text-muted text-xs">
                Ausgestellt {formatDate(device.issued_at)} · Läuft ab {formatRelative(device.expires_at)}
              </span>

              <!-- Backup-Status: Platzhalter für Block 2 -->
              <span class="text-text-muted text-xs" data-testid="device-backup-status">
                {#if device.has_backup}
                  <span class="text-emerald-500">Backup vorhanden</span>
                {:else}
                  <span class="text-amber-500">Kein Backup (noch nicht implementiert)</span>
                {/if}
              </span>

              {#if expiringSoon}
                <span
                  class="mt-0.5 inline-flex items-center gap-1 text-xs text-amber-500"
                  data-testid="device-expiry-warning"
                >
                  <ShieldAlertIcon class="size-3" />
                  Läuft bald ab — wird automatisch erneuert
                </span>
              {/if}
            </div>
          </div>

          <button
            type="button"
            onclick={() => (confirmDevice = device)}
            disabled={revokingId === device.cert_id}
            class="text-destructive bg-destructive/10 hover:bg-destructive/20 self-start rounded-md px-3 py-2 text-xs font-medium transition-colors disabled:opacity-50 sm:self-auto md:py-1.5"
            data-testid="device-revoke"
          >
            {revokingId === device.cert_id ? 'Abmelden…' : 'Abmelden'}
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<AlertDialog.Root bind:open={dialogOpen}>
  <AlertDialog.Content data-testid="device-revoke-dialog">
    <AlertDialog.Header>
      <AlertDialog.Title>Gerät abmelden?</AlertDialog.Title>
      <AlertDialog.Description>
        {#if confirmDevice && isCurrentDevice(confirmDevice)}
          Du meldest <strong>dieses Gerät</strong> ab. Du wirst sofort ausgeloggt und
          musst dich erneut anmelden.
        {:else}
          Das Gerät <strong>{confirmDevice?.device_label ?? ''}</strong> verliert den
          Zugriff auf dein Konto. Aktive Sessions auf diesem Gerät werden ungültig.
        {/if}
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel disabled={revokingId !== null}>Abbrechen</AlertDialog.Cancel>
      <Button
        variant="destructive"
        onclick={() => confirmDevice && handleRevoke(confirmDevice)}
        disabled={revokingId !== null}
        data-testid="device-revoke-confirm"
      >
        {revokingId !== null ? 'Abmelden…' : 'Abmelden'}
      </Button>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
