<!--
  Self-Host-Diagnose-Paket (Spec 2026-09-21 §7, Phase 3). Nur auf Self-Host
  gerendert (AdminSettingsTab gated mit {#if !isCloud}).

  Ablauf: Paket vom EIGENEN Server holen (chat-gateway, Admin-Gate) → mit dem
  Cloud-Konto des Betreibers nach howispulse.com einreichen (Owner-Gate dort).
  Der Server ruft die Cloud nie selbst an — der Browser ist der Kurier.
  Scheitert der Versand, gibt es das Paket als Datei (gleicher Fallback wie
  beim Käfer-Knopf).
-->
<script lang="ts">
  import { errText } from '$lib/utils/errText';
  import { Button } from '$lib/components/ui/button';
  import * as Alert from '$lib/components/ui/alert/index.js';
  import StethoscopeIcon from '@lucide/svelte/icons/stethoscope';
  import DownloadIcon from '@lucide/svelte/icons/download';
  import { toast } from 'svelte-sonner';
  import { m } from '$lib/paraglide/messages.js';
  import { adminApi } from '$lib/api/admin';
  import { reicheServerPaketEin } from '$lib/api/diagnose';
  import { activeServer } from '$lib/stores/active-server.svelte';

  let busy = $state(false);
  let fehler = $state<string | null>(null);
  let dateiOfferiert = $state(false);
  let letztesPaket = $state<Record<string, unknown> | null>(null);

  function alsDatei(): void {
    if (!letztesPaket) return;
    const blob = new Blob([JSON.stringify(letztesPaket, null, 2)], {
      type: 'application/json'
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pulse-server-diagnose-${new Date().toISOString().slice(0, 19)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  async function senden(): Promise<void> {
    if (busy) return;
    const instanceId = activeServer.current?.instance_id;
    if (!instanceId) {
      fehler = m.selfhost_diagnose_ohne_instanz();
      return;
    }
    busy = true;
    fehler = null;
    dateiOfferiert = false;
    try {
      // 1. Paket vom EIGENEN Server holen ...
      const paket = await adminApi.selfHostDiagnosePaket();
      letztesPaket = paket;
      // 2. ... und über den Cloud-Account des Betreibers einreichen.
      await reicheServerPaketEin(instanceId, paket);
      toast.success(m.selfhost_diagnose_gesendet());
    } catch (e) {
      fehler = errText(e) || m.selfhost_diagnose_fehler();
      // Ohne Paket (Server selbst nicht erreichbar — genau der eigentliche
      // Vorfall) gibt es nichts als Datei; das wird dem Betreiber extra
      // gesagt statt still auszubleiben.
      if (letztesPaket === null) fehler = `${fehler} ${m.selfhost_diagnose_server_offline()}`;
      else dateiOfferiert = true;
    } finally {
      busy = false;
    }
  }
</script>

<section
  class="rounded-2xl border border-border bg-bg-input p-5"
  data-testid="admin-self-host-diagnose"
>
  <div class="mb-4 flex items-start gap-3">
    <StethoscopeIcon class="text-text-muted mt-0.5 size-5 shrink-0" />
    <div class="min-w-0">
      <h2 class="text-text-bright text-base font-semibold">{m.selfhost_diagnose_titel()}</h2>
      <p class="text-text-muted mt-0.5 text-xs">{m.selfhost_diagnose_beschreibung()}</p>
    </div>
  </div>

  <div class="flex flex-wrap items-center gap-3">
    <Button onclick={senden} disabled={busy} data-testid="selfhost-diagnose-senden">
      {busy ? m.selfhost_diagnose_laeuft() : m.selfhost_diagnose_knopf()}
    </Button>
    {#if dateiOfferiert}
      <Button variant="ghost" onclick={alsDatei} data-testid="selfhost-diagnose-als-datei">
        <DownloadIcon class="size-4" />
        {m.selfhost_diagnose_als_datei()}
      </Button>
    {/if}
  </div>

  {#if fehler}
    <div class="mt-3">
      <Alert.Root variant="destructive">
        <Alert.Description>{fehler}</Alert.Description>
      </Alert.Root>
    </div>
  {/if}

  <p class="text-text-muted mt-3 text-xs">{m.selfhost_diagnose_inhalt()}</p>
</section>
