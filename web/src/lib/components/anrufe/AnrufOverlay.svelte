<script lang="ts">
  /**
   * Das Anruf-Overlay (Anrufe-Epic C) — global im App-Layout, weil ein
   * Anruf kein Bildschirm ist, der einem Kanal gehört: er überdauert
   * Navigation. Klingeln (ausgehend/eingehend) und laufender Anruf in
   * einem Panel; Desktop bekommt dieselbe Kachel als schwebende Karte.
   *
   * Der Medienweg ist unabhängig davon, wo man gerade navigiert — das
   * Overlay ist reine Steuerung (Annehmen/Ablehnen/Stumm/Auflegen).
   */
  import { anrufe } from '$lib/anrufe/anruf.svelte';
  import { viewport } from '$lib/stores/viewport.svelte';
  import { formatiereDauer } from '$lib/attachments/aufnahmeKern';
  import MicIcon from '@lucide/svelte/icons/mic';
  import MicOffIcon from '@lucide/svelte/icons/mic-off';
  import PhoneIcon from '@lucide/svelte/icons/phone';
  import PhoneOffIcon from '@lucide/svelte/icons/phone-off';
  import VideoIcon from '@lucide/svelte/icons/video';
  import { m } from '$lib/paraglide/messages.js';

  const aktiv = $derived(anrufe.aktiv);
  const titel = $derived(
    aktiv?.rolle === 'eingehend'
      ? m.anruf_eingehend()
      : aktiv?.zustand === 'klingelt'
        ? m.anruf_ausgehend()
        : aktiv?.art === 'gruppe'
          ? m.anruf_gruppenanruf()
          : m.anruf_laeuft()
  );
</script>

{#if aktiv}
  <div
    class="{viewport.istHandy
      ? 'fixed inset-x-0 bottom-0 z-40'
      : 'fixed right-4 bottom-4 z-40 w-72'}"
    data-testid="call-overlay"
  >
    <div class="glass-panel m-3 rounded-2xl border border-border p-4 shadow-2xl">
      <p class="text-text-muted text-xs font-bold uppercase">{titel}</p>
      <p class="text-text-bright mt-0.5 truncate text-base font-bold" data-testid="call-gegenstelle">
        {aktiv.gegenstelle || m.anruf_unbekannte_gegenstelle()}
      </p>
      <p class="text-text-muted text-xs tabular-nums">
        {aktiv.zustand === 'verbunden'
          ? formatiereDauer(anrufe.dauerSekunden)
          : m.anruf_klingelt_hinweis()}
      </p>

      <div class="mt-3 flex items-center justify-center gap-3">
        {#if aktiv.rolle === 'eingehend' && aktiv.zustand === 'klingelt'}
          <!-- Eingehend: Annehmen (links, grün) / Ablehnen (rot) -->
          <button
            type="button"
            class="flex size-12 items-center justify-center rounded-full bg-green-600 text-white"
            onclick={() => void anrufe.annehmen(aktiv.gegenstelle)}
            aria-label={m.anruf_annehmen()}
            data-testid="call-accept"
          >
            <PhoneIcon class="size-5" />
          </button>
          <button
            type="button"
            class="flex size-12 items-center justify-center rounded-full bg-red-600 text-white"
            onclick={() => void anrufe.ablehnen()}
            aria-label={m.anruf_ablehnen()}
            data-testid="call-decline"
          >
            <PhoneOffIcon class="size-5" />
          </button>
        {:else}
          <!-- Laufend/Ausgehend: Stumm, (Kamera), Auflegen -->
          <button
            type="button"
            class="flex size-11 items-center justify-center rounded-full {anrufe.stumm
              ? 'bg-red-600 text-white'
              : 'bg-bg-input text-text-bright border border-border'}"
            onclick={() => void anrufe.stummUmschalten()}
            aria-label={m.anruf_stumm()}
            data-testid="call-mute"
          >
            {#if anrufe.stumm}<MicOffIcon class="size-4" />{:else}<MicIcon class="size-4" />{/if}
          </button>
          {#if aktiv.zustand === 'verbunden'}
            <button
              type="button"
              class="flex size-11 items-center justify-center rounded-full {anrufe.kameranAn
                ? 'bg-primary text-white'
                : 'bg-bg-input text-text-bright border border-border'}"
              onclick={() => void anrufe.kameraUmschalten()}
              aria-label={m.anruf_kamera()}
              data-testid="call-camera"
            >
              <VideoIcon class="size-4" />
            </button>
          {/if}
          <button
            type="button"
            class="flex size-12 items-center justify-center rounded-full bg-red-600 text-white"
            onclick={() => void anrufe.auflegen()}
            aria-label={m.anruf_auflegen()}
            data-testid="call-hangup"
          >
            <PhoneOffIcon class="size-5" />
          </button>
        {/if}
      </div>
    </div>
  </div>
{/if}
