<!--
  DiagnosticButton — kicks off a short AV1 bitstream capture and uploads it to
  the Pulse server for admin analysis. Built for the AMD-VAAPI-AV1 freeze
  investigation: the user can't reasonably share a 5 MB file through chat or
  cloud storage, so we collect it inside the app via the sidecar's
  `record_diagnostic` op (records ~10 s to a temp file → POSTs to
  chat-gateway's diagnostics endpoint with a bearer token).

  Flow:
    1. User clicks → confirm dialog explains what gets uploaded
    2. Confirm → call gsr.recordDiagnostic + start listening for
       `diagnostic_done` events
    3. Sidecar opens portal picker, captures ~10 s, uploads, emits event
    4. Toast on success / error

  Visibility: rendered next to the StreamLog so it sits in the HQ-Stream
  panel without crowding the start/stop control. Renders only when the
  Electron bridge is available (no point on a plain browser).
-->
<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
  import LifeBuoyIcon from '@lucide/svelte/icons/life-buoy';
  import LoaderIcon from '@lucide/svelte/icons/loader-circle';
  import { toast } from 'svelte-sonner';
  import { CHAT_BASE, currentAccessToken } from '$lib/api/client';
  import { gsr, type GsrEvent } from '../gsr';
  import { stream } from '../state.svelte';

  let confirmOpen = $state(false);
  let busy = $state(false);
  let cleanupListener: (() => void) | null = null;

  let canRun = $derived(gsr.available() && stream.available && !busy && !stream.running);

  function buildUploadUrl(): string {
    // `window.location.origin` matches the host the renderer is served from —
    // dev → http://localhost:5173 (Vite proxies /api/chat to :8002),
    // prod → https://pulse.unicutmedia.com (Caddy + pulse_web nginx).
    return `${window.location.origin}${CHAT_BASE}/diagnostics/upload`;
  }

  async function buildMetadata(): Promise<Record<string, unknown>> {
    const meta: Record<string, unknown> = {
      ua: typeof navigator !== 'undefined' ? navigator.userAgent : '',
      // Tail of the per-session GSR log — the most recent lines are the
      // ones most likely to be relevant (errors, state changes).
      gsr_log_tail: stream.lastLog.slice(-50),
    };
    try {
      const h = await gsr.health();
      if (h) meta.health = h;
    } catch {
      /* health probe failure isn't fatal here */
    }
    return meta;
  }

  async function startDiagnostic() {
    if (!canRun) return;
    const token = currentAccessToken();
    if (!token) {
      toast.error('Diagnose nicht möglich', {
        description: 'Du bist nicht eingeloggt — neu anmelden, dann nochmal.',
      });
      return;
    }
    busy = true;

    // Subscribe to `diagnostic_done` before kicking off the op. The sidecar
    // may emit very quickly (e.g. start failure) and we don't want to miss
    // the event.
    const unsub = await gsr.onEvent((ev: GsrEvent) => {
      if (ev.ev !== 'diagnostic_done') return;
      cleanupListener?.();
      cleanupListener = null;
      busy = false;
      if (ev.ok) {
        toast.success('Diagnose gesendet', {
          description: `Datei: ${ev.filename ?? '?'} (${(ev.size_bytes / (1024 * 1024)).toFixed(1)} MB)`,
        });
      } else {
        toast.error('Diagnose fehlgeschlagen', {
          description: ev.error ?? 'Unbekannter Fehler',
        });
      }
    });
    cleanupListener = unsub;

    try {
      const metadata = await buildMetadata();
      const r = await gsr.recordDiagnostic({
        duration_s: 40,
        upload_url: buildUploadUrl(),
        access_token: token,
        codec: 'av1',
        metadata,
      });
      if (r && !r.ok) {
        cleanupListener?.();
        cleanupListener = null;
        busy = false;
        toast.error('Diagnose konnte nicht starten', {
          description: r.error ?? 'Unbekannter Fehler vom Sidecar',
        });
      }
    } catch (e) {
      cleanupListener?.();
      cleanupListener = null;
      busy = false;
      toast.error('Diagnose konnte nicht starten', {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  }

  function onConfirm() {
    confirmOpen = false;
    void startDiagnostic();
  }
</script>

{#if gsr.available()}
  <div class="flex flex-col gap-1" data-testid="diagnostic-button">
    <Button
      type="button"
      variant="ghost"
      size="sm"
      class="w-fit gap-1.5"
      disabled={!canRun}
      onclick={() => (confirmOpen = true)}
      data-testid="diagnostic-button-trigger"
    >
      {#if busy}
        <LoaderIcon class="size-3.5 animate-spin" />
        Diagnose läuft…
      {:else}
        <LifeBuoyIcon class="size-3.5" />
        Diagnose-Aufnahme senden
      {/if}
    </Button>
    {#if !stream.running}
      <p class="text-text-muted text-[11px]">
        Erzeugt eine ~40 s AV1-Aufnahme + GSR-Log und schickt sie zur Bug-Analyse an Pulse.
      </p>
    {/if}
  </div>

  <AlertDialog.Root bind:open={confirmOpen}>
    <AlertDialog.Content data-testid="diagnostic-confirm-dialog">
      <AlertDialog.Header>
        <AlertDialog.Title>Diagnose-Aufnahme senden?</AlertDialog.Title>
        <AlertDialog.Description>
          <span class="block">
            Es wird gleich eine etwa <strong>40-sekündige Bildschirm-Aufnahme</strong> mit
            dem AV1-Encoder gemacht. Die Aufnahme + dein aktueller GSR-Log + Browser-Info
            werden direkt an den Pulse-Server geschickt zur Analyse des AMD-AV1-Freeze-Bugs.
          </span>
          <span class="text-text-muted mt-2 block text-xs">
            Pflicht: gleich erscheint der Wayland-Bildschirm-Auswahldialog (wie beim normalen Stream).
            Es lohnt sich, in den 40 s etwas auf dem Bildschirm zu bewegen (Maus, Scrollen) —
            ruhiger Inhalt liefert weniger aussagekräftige Daten. Lang genug damit der Freeze
            zuverlässig drin landet.
          </span>
        </AlertDialog.Description>
      </AlertDialog.Header>
      <AlertDialog.Footer>
        <AlertDialog.Cancel>Abbrechen</AlertDialog.Cancel>
        <AlertDialog.Action onclick={onConfirm}>Aufnahme starten</AlertDialog.Action>
      </AlertDialog.Footer>
    </AlertDialog.Content>
  </AlertDialog.Root>
{/if}
