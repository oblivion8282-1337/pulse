<!--
  Vereintes Antragsformular fürs Hosting (VPS + App-Host) im Einstellungs-
  Dialog. Zwei Wege, EIN Antragssystem (origin unterscheidet):
    - "Auf eigenem Server" (vps): Hostname-Feld wie bisher.
    - "Zuhause mit der Server-App" (app_host): kein Hostname, dafür
      Pflicht-Anschluss-Check (beratend gespeichert als network_check).
  Auf Mobilgeräten wird der App-Host-Weg nicht angeboten (Einrichtung
  braucht den Desktop) — stattdessen eine Hinweiszeile.
  Endpoint: POST/GET /me/instance-applications (Cookie-Auth via instancesApi).
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { toast } from 'svelte-sonner';
  import { myInstanceApplications } from '$lib/stores/myInstanceApplications.svelte';
  import { myAppHostApplications } from '$lib/stores/myAppHostApplications.svelte';
  import { instancesApi, type InstanceApplication } from '$lib/api/instances';
  import {
    networkCheckWireValue,
    type HostingVerdict
  } from '$lib/hosting/connectivityCheck';
  import ConnectivityCheckPanel from './ConnectivityCheckPanel.svelte';
  import { isMobile } from '$lib/platform/runtime';
  import { APP_HOSTING_ENABLED } from '$lib/featureFlags';
  import ServerIcon from '@lucide/svelte/icons/server';
  import HouseIcon from '@lucide/svelte/icons/house';
  import CloudIcon from '@lucide/svelte/icons/cloud';
  import { m } from '$lib/paraglide/messages.js';
  import FieldError from '$lib/components/feedback/FieldError.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import FieldLabel from '$lib/components/form/FieldLabel.svelte';
  import Select from '$lib/components/form/Select.svelte';

  type Mode = 'vps' | 'app_host';
  const mobile = isMobile();

  const zweckOptionen = $derived([
    { value: 'privat', label: m.app_host_apply_purpose_privat() },
    { value: 'verein', label: m.app_host_apply_purpose_verein() },
    { value: 'firma', label: m.app_host_apply_purpose_firma() },
    { value: 'sonst', label: m.app_host_apply_purpose_sonst() },
  ]);

  let mode = $state<Mode>('vps');
  let hostname = $state('');
  let purpose = $state<'privat' | 'verein' | 'firma' | 'sonst'>('privat');
  let message = $state('');
  // null = Probe läuft noch / kein Ergebnis (Submit erlaubt). 'cannot-host'
  // blockt den Submit + zeigt die Warn-Box (im ConnectivityCheckPanel).
  let netCheck = $state<HostingVerdict | null>(null);
  let submitting = $state(false);
  let formError = $state<string | null>(null);

  let applications = $state<InstanceApplication[]>([]);
  let listLoading = $state(true);

  onMount(async () => {
    await reload();
  });

  async function reload() {
    listLoading = true;
    try {
      // Nur offene + abgelehnte/zurückgenommene (mit Begründung) sind hier
      // relevant. Genehmigte leben als Server weiter, 'closed' ist Historie —
      // Positiv-Filter statt Ausblendungs-Liste (unbekannte Endstati würden
      // sonst fälschlich angezeigt).
      const all = await instancesApi.listMyApplications('all', 'all');
      applications = all.filter(
        (a) => a.status === 'pending' || a.status === 'rejected' || a.status === 'revoked'
      );
    } catch {
      // Nicht kritisch — Liste bleibt leer
    } finally {
      listLoading = false;
    }
  }

  async function submit() {
    formError = null;
    if (mode === 'vps') {
      if (!hostname.trim()) {
        formError = m.self_host_application_hostname_required();
        return;
      }
    } else if (netCheck === 'cannot-host') {
      // Defensiv — der Submit-Button ist in diesem Fall ohnehin disabled;
      // die Warn-Box im Panel erklärt den Grund + die VPS-Alternative.
      return;
    }
    submitting = true;
    try {
      const created =
        mode === 'vps'
          ? await instancesApi.submitApplication({ hostname: hostname.trim() })
          : await instancesApi.submitApplication({
              origin: 'app_host',
              purpose,
              notes: message.trim() || null,
              network_check: netCheck ? networkCheckWireValue(netCheck) : null
            });
      // Antrag beobachten → Owner-Toast, sobald genehmigt/abgelehnt wird.
      if (mode === 'vps') myInstanceApplications.register(created.id);
      else myAppHostApplications.register(created);
      toast.success(m.self_host_application_submitted_toast());
      hostname = '';
      message = '';
      netCheck = null;
      await reload();
    } catch (e) {
      formError = e instanceof Error ? e.message : String(e);
    } finally {
      submitting = false;
    }
  }

  function statusLabel(s: string): string {
    if (s === 'pending') return m.self_host_application_status_pending();
    if (s === 'approved') return m.self_host_application_status_approved();
    if (s === 'revoked') return m.app_host_admin_status_revoked();
    return m.self_host_application_status_rejected();
  }

  function statusClass(s: string): string {
    if (s === 'approved') return 'bg-success/20 text-success';
    if (s === 'pending') return 'bg-warning/20 text-warning';
    return 'bg-destructive/20 text-destructive';
  }

  const MODE_BTN =
    'flex flex-1 items-start gap-2.5 rounded-xl border p-3 text-left transition-colors';

  function modeBtnState(active: boolean): string {
    return active
      ? 'border-primary bg-primary/10'
      : 'border-border bg-bg-input/40 hover:bg-bg-hover';
  }
</script>

<div class="flex flex-col gap-5" data-testid="self-host-application">
  <form onsubmit={(e) => { e.preventDefault(); void submit(); }}
        class="border-border bg-bg-input/40 flex flex-col gap-3 rounded-2xl border p-4">
    <!-- Wo soll der Server laufen? Links "Auf eigenem Server" (aktiv), rechts
         "Von Pulse gehostet" als ausgegrauter Teaser für ein künftiges Feature
         (Pulse hostet den Server). Die App-Host-Kachel (eigenes Gerät) ist
         geparkt und erscheint nur, wenn App-Hosting wieder aktiviert wird
         (APP_HOSTING_ENABLED); mode bleibt sonst auf 'vps'. -->
    <p class="text-text-bright text-xs font-medium">{m.hosting_apply_mode_label()}</p>
    <div class="flex flex-col gap-2 sm:flex-row">
      <button type="button" onclick={() => (mode = 'vps')}
        class="{MODE_BTN} {modeBtnState(mode === 'vps')}"
        data-testid="hosting-mode-vps">
        <ServerIcon class="text-text-muted mt-0.5 size-4 shrink-0" />
        <span class="flex flex-col gap-0.5">
          <span class="text-text-bright text-sm font-medium">{m.hosting_apply_mode_vps_title()}</span>
          <span class="text-text-muted text-xs">{m.hosting_apply_mode_vps_desc()}</span>
        </span>
      </button>
      {#if APP_HOSTING_ENABLED && !mobile}
        <button type="button" onclick={() => (mode = 'app_host')}
          class="{MODE_BTN} {modeBtnState(mode === 'app_host')}"
          data-testid="hosting-mode-app-host">
          <HouseIcon class="text-text-muted mt-0.5 size-4 shrink-0" />
          <span class="flex flex-col gap-0.5">
            <span class="text-text-bright text-sm font-medium">{m.hosting_apply_mode_app_title()}</span>
            <span class="text-text-muted text-xs">{m.hosting_apply_mode_app_desc()}</span>
          </span>
        </button>
      {/if}
      <!-- Teaser: von Pulse gehostet — noch nicht implementiert, daher
           ausgegraut + nicht klickbar. -->
      <div class="{MODE_BTN} border-border bg-bg-input/20 cursor-not-allowed opacity-60"
        aria-disabled="true" data-testid="hosting-mode-managed">
        <CloudIcon class="text-text-muted mt-0.5 size-4 shrink-0" />
        <span class="flex flex-col gap-0.5">
          <span class="flex items-center gap-1.5">
            <span class="text-text-bright text-sm font-medium">{m.hosting_apply_mode_managed_title()}</span>
            <span class="bg-bg-input text-text-muted rounded-full px-1.5 py-0.5 text-2xs font-medium uppercase tracking-wide">{m.hosting_apply_mode_managed_badge()}</span>
          </span>
          <span class="text-text-muted text-xs">{m.hosting_apply_mode_managed_desc()}</span>
        </span>
      </div>
    </div>
    {#if APP_HOSTING_ENABLED && mobile}
      <p class="text-text-muted text-xs">{m.hosting_apply_mobile_hint()}</p>
    {/if}

    {#if mode === 'vps'}
      <div class="flex flex-col gap-1">
        <FieldLabel class="text-text-bright text-xs font-medium" for="sha-hostname" required>
          {m.self_host_application_hostname_label()}
        </FieldLabel>
        <Input
          id="sha-hostname"
          type="text"
          bind:value={hostname}
          aria-required="true"
          placeholder="pulse.example.org"
        />
      </div>
    {:else}
      <div class="flex flex-col gap-1">
        <Label class="text-text-bright text-xs font-medium" for="sha-purpose">
          {m.app_host_apply_purpose_label()}
        </Label>
        <Select
          id="sha-purpose"
          value={purpose}
          options={zweckOptionen}
          onchange={(v) => (purpose = v as 'privat' | 'verein' | 'firma' | 'sonst')}
        />
      </div>
      <div class="flex flex-col gap-1">
        <Label class="text-text-bright text-xs font-medium" for="sha-message">
          {m.app_host_apply_message_label()}
          <span class="text-text-muted font-normal">{m.app_host_apply_message_optional()}</span>
        </Label>
        <textarea id="sha-message" bind:value={message} rows="2" maxlength="2000"
          placeholder={m.app_host_apply_message_placeholder()}
          class="bg-bg-input border-border text-text-bright placeholder:text-text-muted resize-none rounded-xl border px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
        ></textarea>
      </div>
      <ConnectivityCheckPanel onresult={(r) => (netCheck = r)} />
    {/if}

    <FieldError message={formError} />

    <Button
      type="submit"
      class="self-end"
      disabled={submitting || (mode === 'app_host' && netCheck === 'cannot-host')}
    >
      {submitting ? m.self_host_application_submitting() : m.self_host_application_submit()}
    </Button>
  </form>

  <!-- Antragsliste (beide Arten) -->
  {#if !listLoading && applications.length > 0}
    <div class="flex flex-col gap-2">
      <h4 class="text-text-muted text-xs font-semibold uppercase tracking-wide">{m.self_host_application_my_applications()}</h4>
      {#each applications as app (app.id)}
        <div class="border-border bg-bg-input/30 flex items-start justify-between gap-3 rounded-xl border p-3">
          <div class="min-w-0">
            <p class="text-text-bright text-sm font-medium truncate">
              {app.origin === 'app_host' ? m.hosting_apply_mode_app_title() : app.hostname}
            </p>
            <p class="text-text-muted text-xs mt-0.5">
              {new Date(app.created_at).toLocaleDateString('de-DE')}
              · {app.purpose}
            </p>
          </div>
          <div class="flex flex-col items-end gap-1 shrink-0">
            <div class="flex items-center gap-1.5">
              <span class="border-border text-text-muted rounded-full border px-2 py-0.5 text-xs"
                    data-testid="application-origin-chip">
                {app.origin === 'app_host' ? m.hosting_origin_app() : m.hosting_origin_vps()}
              </span>
              <span class="rounded-full px-2 py-0.5 text-xs font-medium {statusClass(app.status)}">
                {statusLabel(app.status)}
              </span>
            </div>
            {#if (app.status === 'rejected' || app.status === 'revoked') && app.rejection_reason}
              <span class="text-text-muted text-xs max-w-40 text-right" title={app.rejection_reason}>
                {app.rejection_reason.length > 60
                  ? app.rejection_reason.slice(0, 60) + '…'
                  : app.rejection_reason}
              </span>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>
