<script lang="ts">
  /**
   * Der Raum aus Gastsicht — aufgebaut wie die Sprachkanal-Ansicht der App:
   * Stream-Raster in der Mitte, darunter die Teilnehmer-Kacheln als
   * waagerechte Reihe (``GastTeilnehmerKachel``, die kleine Schwester von
   * ``VoiceParticipantTile``), unten die runde Anruf-Leiste.
   *
   * Die Knopfreihe bleibt einzeilig (fünf runde 56-px-Knöpfe passen auf
   * 390 px nicht nebeneinander) — deshalb sind es hier nur drei.
   */
  import { Button } from '$lib/components/ui/button';
  import { m } from '$lib/paraglide/messages.js';
  import MicIcon from '@lucide/svelte/icons/mic';
  import MicOffIcon from '@lucide/svelte/icons/mic-off';
  import VideoIcon from '@lucide/svelte/icons/video';
  import VideoOffIcon from '@lucide/svelte/icons/video-off';
  import PhoneOffIcon from '@lucide/svelte/icons/phone-off';
  import { gastRaum } from './gastRaum.svelte';
  import { gastStreams } from './gastStreams.svelte';
  import GastVideoFlaeche from './GastVideoFlaeche.svelte';
  import GastTeilnehmerKachel from './GastTeilnehmerKachel.svelte';

  let { titel, community }: { titel: string; community: string } = $props();
</script>

<div class="flex min-h-dvh flex-col">
  <header class="glass-panel flex items-center justify-between gap-3 px-4 py-3">
    <div class="min-w-0">
      <h1 class="text-text-bright truncate text-base font-semibold">{titel}</h1>
      <p class="text-muted-foreground truncate text-xs">{community}</p>
    </div>
    <span
      class="text-2xs border-amber-500/60 bg-amber-500/10 text-amber-500 shrink-0 rounded-full border px-2 py-0.5 uppercase"
    >
      {m.gast_abzeichen()}
    </span>
  </header>

  <main class="flex min-h-0 min-w-0 flex-1 flex-col gap-2 p-0 md:gap-3 md:p-3">
    <GastVideoFlaeche />

    {#if gastRaum.teilnehmer.length > 0}
      {@const rasterLeer =
        gastStreams.offen.length === 0 &&
        !gastRaum.videos.some(
          (v) => v.quelle !== 'camera' || gastRaum.kamerasImBlick.includes(v.identity)
        )}
      <!-- Die Teilnehmer-Reihe: nicht umbrechend wie
           ``VoiceParticipantStrip`` — bei vielen Leuten wird waagerecht
           gewischt, jede Umbruch-Reihe kostete Höhe. Läuft kein Stream, steht
           die Reihe mittig in der Fläche (wie die leeren Kacheln der App);
           mit Stream rückt sie nach unten. -->
      <div
        class="flex min-w-0 px-1 {rasterLeer ? 'flex-1 items-center' : 'shrink-0 items-end'}"
      >
        <div
          class="flex min-w-0 flex-1 flex-nowrap items-center gap-3 overflow-x-auto overflow-y-hidden py-2"
          style="justify-content: safe center;"
          data-testid="gast-teilnehmer-reihe"
        >
          {#each gastRaum.teilnehmer as t (t.identity)}
            <GastTeilnehmerKachel {t} />
          {/each}
        </div>
      </div>
    {/if}
  </main>

  <footer class="px-4 pb-4">
    <!-- w-fit: das Dock schmiegt sich um die drei Knöpfe wie die schwebende
         Steuerung der App, statt als Balken über die ganze Breite zu laufen. -->
    <div class="border-border bg-bg-input mx-auto flex w-fit flex-nowrap items-center justify-center gap-3 rounded-[14px] border p-2">
      <Button
        variant={gastRaum.mikroStumm ? 'secondary' : 'default'}
        class="size-14 rounded-full"
        title={gastRaum.mikroStumm ? m.gast_mikro_an() : m.gast_mikro_aus()}
        aria-label={gastRaum.mikroStumm ? m.gast_mikro_an() : m.gast_mikro_aus()}
        onclick={() => gastRaum.mikroUmschalten()}
        data-testid="gast-mikro"
      >
        {#if gastRaum.mikroStumm}
          <MicOffIcon class="size-6" />
        {:else}
          <MicIcon class="size-6" />
        {/if}
      </Button>
      <Button
        variant={gastRaum.kameraAn ? 'default' : 'secondary'}
        class="size-14 rounded-full"
        title={gastRaum.kameraAn ? m.gast_kamera_aus() : m.gast_kamera_an()}
        aria-label={gastRaum.kameraAn ? m.gast_kamera_aus() : m.gast_kamera_an()}
        onclick={() => gastRaum.kameraUmschalten()}
        data-testid="gast-kamera"
      >
        {#if gastRaum.kameraAn}
          <VideoIcon class="size-6" />
        {:else}
          <VideoOffIcon class="size-6" />
        {/if}
      </Button>
      <Button
        variant="destructive"
        class="size-14 rounded-full"
        title={m.gast_auflegen()}
        aria-label={m.gast_auflegen()}
        onclick={() => gastRaum.verlassen()}
        data-testid="gast-auflegen"
      >
        <PhoneOffIcon class="size-6" />
      </Button>
    </div>
  </footer>
</div>
