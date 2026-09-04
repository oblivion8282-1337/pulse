<script lang="ts">
  /**
   * Die Videofläche: HQ-Übertragungen (WHEP) und Browser-Bildschirmfreigaben
   * (LiveKit) nebeneinander.
   *
   * Die beiden kommen über verschiedene Wege herein — die eine über eine
   * eigene WebRTC-Verbindung zu MediaMTX, die andere als Track im Sprachraum —
   * und sehen für den Gast trotzdem gleich aus. Genau deshalb liegen sie in
   * EINER Fläche: der Unterschied ist Technik, keine Bedienung.
   */
  import { m } from '$lib/paraglide/messages.js';
  import { gastRaum } from './gastRaum.svelte';
  import { gastStreams } from './gastStreams.svelte';

  let hqVideo = $state<HTMLVideoElement | null>(null);

  /** Ein LiveKit-Video an sein Element hängen (und beim Wechsel lösen). */
  function anhaengen(el: HTMLVideoElement, track: { attach: (e: HTMLMediaElement) => void; detach: (e: HTMLMediaElement) => void }) {
    track.attach(el);
    return {
      destroy() {
        track.detach(el);
      }
    };
  }
</script>

<div class="bg-muted/30 flex-1 space-y-3 p-4">
  {#if gastStreams.sender.length > 0}
    <div class="space-y-2">
      <div class="flex flex-wrap items-center gap-2">
        {#each gastStreams.sender as uid (uid)}
          <button
            class="rounded-md border px-3 py-1.5 text-sm"
            class:bg-primary={gastStreams.offen === uid}
            class:text-primary-foreground={gastStreams.offen === uid}
            onclick={() => hqVideo && gastStreams.ansehen(uid, hqVideo)}
            data-testid="gast-stream-waehlen"
          >
            {m.gast_stream_ansehen()}
          </button>
        {/each}
        {#if gastStreams.fehler}
          <!-- Sonst klickt der Gast auf „Ansehen" und es passiert sichtbar
               nichts: der Fehler wurde gesetzt und nirgends gezeigt. -->
          <span class="text-destructive text-sm" data-testid="gast-stream-fehler">
            {m.gast_stream_fehler()}
          </span>
        {/if}
        {#if gastStreams.offen}
          <button class="text-muted-foreground text-sm underline" onclick={() => gastStreams.schliessen()}>
            {m.gast_stream_schliessen()}
          </button>
        {/if}
      </div>
      <!-- svelte-ignore a11y_media_has_caption -->
      <video
        bind:this={hqVideo}
        class="aspect-video w-full rounded-lg bg-black"
        class:hidden={!gastStreams.offen}
        playsinline
        controls
        data-testid="gast-hq-video"
      ></video>
    </div>
  {/if}

  <!-- Die Spur-Kennung gehört in den Schlüssel: wechselt jemand mitten in der
       Besprechung die Kamera, ist es derselbe Sender mit derselben Quelle,
       aber ein NEUER Track. Ohne sie liefe die Einhäng-Action nicht erneut
       (sie hat keinen Update-Zweig) und die Kachel zeigte weiter das alte,
       stehende Bild. -->
  {#each gastRaum.videos as v (v.identity + v.quelle + (v.track.sid ?? ''))}
    <figure class="space-y-1">
      <!-- svelte-ignore a11y_media_has_caption -->
      <video
        class="aspect-video w-full rounded-lg bg-black"
        playsinline
        autoplay
        use:anhaengen={v.track}
      ></video>
      <figcaption class="text-muted-foreground text-xs">{v.name}</figcaption>
    </figure>
  {/each}

  {#if gastStreams.sender.length === 0 && gastRaum.videos.length === 0}
    <p class="text-muted-foreground py-8 text-center text-sm">{m.gast_kein_bild()}</p>
  {/if}
</div>
