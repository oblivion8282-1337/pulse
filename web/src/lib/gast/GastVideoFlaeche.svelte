<script lang="ts">
  /**
   * Das Kachel-Raster der Gast-Videofläche: HQ-Übertragungen (WHEP) und
   * Kamera-Bilder (LiveKit) nebeneinander.
   *
   * Die beiden kommen über verschiedene Wege herein — die eine über eine
   * eigene WebRTC-Verbindung zu MediaMTX, die andere als Track im Sprachraum —
   * und sehen für den Gast trotzdem gleich aus. Genau deshalb liegen sie in
   * EINEM Raster: der Unterschied ist Technik, keine Bedienung.
   *
   * Geöffnet wird von den Teilnehmer-Kacheln aus (LIVE/CAM-Abzeichen, s.
   * ``GastTeilnehmerKachel``) — wie in der App, in der das Stream-Grid nur
   * geöffnete Kacheln zeigt. Layout wie ``StreamGrid``: gleichmäßiges Raster,
   * mobil einspaltig.
   */
  import { m } from '$lib/paraglide/messages.js';
  import Volume2Icon from '@lucide/svelte/icons/volume-2';
  import VolumeXIcon from '@lucide/svelte/icons/volume-x';
  import MaximizeIcon from '@lucide/svelte/icons/maximize';
  import MinimizeIcon from '@lucide/svelte/icons/minimize';
  import XIcon from '@lucide/svelte/icons/x';
  import { gastRaum } from './gastRaum.svelte';
  import { gastStreams, senderSchluessel, type GastSender } from './gastStreams.svelte';
  import { viewport } from '$lib/stores/viewport.svelte';

  /** Den WHEP-Strom einer offenen Kachel an ihr <video> hängen. */
  /** Ein LiveKit-Video an sein Element hängen (und beim Wechsel lösen). */
  function anhaengen(el: HTMLVideoElement, track: { attach: (e: HTMLMediaElement) => void; detach: (e: HTMLMediaElement) => void }) {
    track.attach(el);
    return {
      destroy() {
        track.detach(el);
      }
    };
  }

  /** Anzeigename eines Senders — Profil-Name vor LiveKit-Nutzername, rohe
   *  Kennung als letzter Rückfall. */
  function senderName(userId: string): string {
    return gastStreams.profile[userId]?.name ?? senderLiveKitName(userId) ?? `user-${userId}`;
  }

  function senderLiveKitName(userId: string): string | undefined {
    return gastRaum.teilnehmer.find((x) => x.identity === `user-${userId}`)?.name;
  }

  /** Kachel-Text: Name, bei mehreren parallelen Streams desselben Senders
   *  mit der jeweiligen Beschriftung (Monitor-Name bzw. „Übertragung N"). */
  function senderTitel(s: GastSender): string {
    const name = senderName(s.userId);
    const eigene = gastStreams.sender.filter((x) => x.userId === s.userId);
    if (eigene.length <= 1) return name;
    // Slot-Position zählt per Schlüssel — zwei label-lose Streams dürfen
    // nicht durcheinander nummeriert werden.
    const nummer =
      eigene
        .slice()
        .sort((a, b) => a.slot - b.slot)
        .findIndex((x) => senderSchluessel(x) === senderSchluessel(s)) + 1;
    return `${name} · ${s.label || m.gast_stream_nummer({ nummer })}`;
  }

  /** Kameras laufen nur, wenn der Gast sie über das CAM-Abzeichen geöffnet
   *  hat; LiveKit-Bildschirmfreigaben (selten — der normale Weg ist WHEP)
   *  zeigen sich von selbst. */
  let kamerasImRaster = $derived(
    gastRaum.videos.filter(
      (v) => v.quelle !== 'camera' || gastRaum.kamerasImBlick.includes(v.identity)
    )
  );

  // --- Kachel-Steuerung (Dock wie beim Mitglieder-Webplayer) ---------------
  // Native Video-Controls scheidet aus: die Unterleiste (Name/LIVE) liegt
  // genau über ihnen und frisst die Klicks — Lautstärke und Vollbild waren
  // damit unbenutzbar. Stattdessen dieselbe Leiste wie ``TileDock``: Stumm-
  // Knopf, Slider, Prozent, Vollbild, Schließen-X.

  const VOLUMEN_DEFAULT = 100;
  let volumina = $state<Record<string, number>>({});
  let letzteLautstaerke = $state<Record<string, number>>({});
  let vollbildKey = $state<string | null>(null);

  function volumeOf(key: string): number {
    return volumina[key] ?? VOLUMEN_DEFAULT;
  }

  function volumeSetzen(key: string, wert: number): void {
    volumina = { ...volumina, [key]: wert };
    if (wert > 0) letzteLautstaerke = { ...letzteLautstaerke, [key]: wert };
  }

  function stummUmschalten(key: string): void {
    volumeSetzen(key, volumeOf(key) === 0 ? (letzteLautstaerke[key] ?? VOLUMEN_DEFAULT) : 0);
  }

  function vollbildUmschalten(key: string, knopf: HTMLElement): void {
    const kachel = knopf.closest('figure');
    if (!kachel) return;
    if (vollbildKey === key) {
      void document.exitFullscreen().catch(() => undefined);
      return;
    }
    void kachel
      .requestFullscreen?.()
      .then(() => {
        vollbildKey = key;
        pokeHud(); // Timer direkt starten — die Leiste soll sich ja melden
      })
      .catch(() => undefined);
  }

  // --- HUD-Ausblendung im Vollbild (wie TileShell) --------------------------
  // Außerhalb des Vollbilds ist die Leiste dauerhaft sichtbar. Im Vollbild
  // blendet sie nach HUD_HIDE_AFTER_MS ohne Mausbewegung ab und kommt bei
  // jeder Bewegung (mobil: Tipp) zurück — dieselbe Regel, dieselbe Dauer
  // wie ``TileShell``. Das LIVE-Abzeichen koppelt sich an denselben Zustand.
  const HUD_HIDE_AFTER_MS = 3000;
  let hudSichtbar = $state(true);
  let hudTimer: ReturnType<typeof setTimeout> | null = null;

  function pokeHud(): void {
    if (vollbildKey === null) return;
    hudSichtbar = true;
    if (hudTimer) clearTimeout(hudTimer);
    hudTimer = setTimeout(() => (hudSichtbar = false), HUD_HIDE_AFTER_MS);
  }

  /** Leisten-Klassen je Zustand: im Vollbild mit Fade, sonst beständig. */
  function hudKlassen(key: string): string {
    if (vollbildKey !== key) return '';
    return hudSichtbar
      ? 'transition-opacity duration-300 opacity-100'
      : 'pointer-events-none transition-opacity duration-300 opacity-0';
  }

  // Vollbild kann auch von außen enden (Esc) — den Zustand mitführen, damit
  // der Knopf wieder das Maximize-Zeichen zeigt, und die Leiste dauerhaft
  // zurückschalten.
  $effect(() => {
    const sync = () => {
      if (!document.fullscreenElement) {
        vollbildKey = null;
        hudSichtbar = true;
        if (hudTimer) clearTimeout(hudTimer);
      }
    };
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  });

  /** Strom AN das <video> bringen und zugleich die Lautstärke des aktuellen
   *  Dock-Stands setzen — die Action-Update-Phase läuft bei jeder Volume-
   *  Änderung erneut und hält das Element synchron. */
  function stromAnhaengen(el: HTMLVideoElement, optionen: { stream?: MediaStream; volume: number }) {
    const anwenden = () => {
      el.volume = Math.min(1, Math.max(0, optionen.volume / 100));
      el.muted = optionen.volume === 0;
    };
    if (optionen.stream && optionen.stream !== el.srcObject) {
      el.srcObject = optionen.stream;
      anwenden();
      void el.play().catch(() => {
        // Autoplay verweigert (kein Nutzerklick auf DIESES Element): das
        // <video> steht dann still da. Kein Grund zu meckern — der Gast
        // klickt auf Abspielen und es läuft.
      });
    } else {
      anwenden();
    }
    return {
      update(neu: { stream?: MediaStream; volume: number }) {
        optionen = neu;
        if (neu.stream && neu.stream !== el.srcObject) {
          el.srcObject = neu.stream;
          void el.play().catch(() => undefined);
        }
        anwenden();
      },
      destroy() {
        el.srcObject = null;
      }
    };
  }

  /** Die eigene Kamera als Kachel — ohne sie wäre „Kamera an“ ein toter
   *  Knopf: der eigene Track läuft bewusst nicht in ``gastRaum.videos``. */
  let eigeneKameraDa = $derived(!!gastRaum.kameraAn && !!gastRaum.eigenesVideo);

  /** Der eigene Anzeigename (selbst getippt im Vorraum, via LiveKit-Name). */
  function eigenerName(): string {
    return (
      gastRaum.teilnehmer.find((t) => t.identity.startsWith('gast-'))?.name ??
      m.gast_abzeichen()
    );
  }

  // Spalten wie im StreamGrid: 1 mobil, sonst 2 bis vier Kacheln, 3 ab fünf.
  // Inline-Style statt Klassen-Interpolation — ein veralteter grid-cols-*
  // Rest würde sonst eine Spalte zu viel zeigen.
  let rasterStil = $derived.by(() => {
    if (viewport.istHandy) return 'grid-template-columns: minmax(0, 1fr);';
    const n = gastStreams.offen.length + kamerasImRaster.length + (eigeneKameraDa ? 1 : 0);
    const cols = n <= 1 ? 1 : n <= 4 ? 2 : 3;
    return `grid-template-columns: repeat(${cols}, minmax(0, 1fr));`;
  });
</script>

{#if gastStreams.fehler}
  <!-- Sonst klickt der Gast auf LIVE und es passiert sichtbar nichts: der
       Fehler wurde gesetzt und nirgends gezeigt. -->
  <p class="text-destructive text-sm" data-testid="gast-stream-fehler">
    {m.gast_stream_fehler()}
  </p>
{/if}

{#if gastStreams.abfrageHaengt}
  <p class="text-muted-foreground text-xs" data-testid="gast-stream-abfrage-haengt">
    {m.gast_stream_abfrage_haengt()}
  </p>
{/if}

{#if gastStreams.offen.length > 0 || kamerasImRaster.length > 0 || eigeneKameraDa}
  <div class="grid min-h-0 flex-1 auto-rows-fr gap-2 md:gap-3" style={rasterStil}>

    {#if eigeneKameraDa}
      <figure class="border-border shadow-2xl relative min-h-0 w-full min-w-0 overflow-hidden rounded-2xl border bg-black">
        <!-- svelte-ignore a11y_media_has_caption -->
        <video
          class="border-primary/60 absolute inset-0 h-full w-full border-2"
          playsinline
          autoplay
          muted
          use:anhaengen={gastRaum.eigenesVideo!}
        ></video>
        <span
          class="bg-primary/15 text-primary absolute top-2 left-2 z-10 inline-flex items-center rounded-md px-2 py-0.5 text-2xs font-semibold uppercase backdrop-blur-sm"
        >
          {m.gast_kachel_kamera()}
        </span>
        <figcaption
          class="from-black/85 via-black/45 absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t to-transparent px-3 pt-8 pb-2 text-xs"
        >
          <span class="text-white font-semibold">{eigenerName()}</span>
        </figcaption>
      </figure>
    {/if}
    {#each gastStreams.offen as key (key)}
      {@const s = gastStreams.sender.find((x) => senderSchluessel(x) === key)}
      {@const v = volumeOf(key)}
      <figure
        class="border-border shadow-2xl relative min-h-0 w-full min-w-0 overflow-hidden rounded-2xl border bg-black"
        onmousemove={pokeHud}
        onclick={(e) => {
          // Mobil gibt es kein mousemove — ein Tipp aufs Bild weckt die
          // Leiste (dieselbe Regel wie handleCatcherClick in TileShell).
          if (vollbildKey === key) pokeHud();
        }}
        role="presentation"
      >
        <!-- svelte-ignore a11y_media_has_caption -->
        <video
          class="absolute inset-0 h-full w-full"
          playsinline
          use:stromAnhaengen={{ stream: gastStreams.strome[key], volume: v }}
          data-testid="gast-hq-video"
        ></video>
        <span
          class="bg-badge-live absolute top-2 left-2 z-10 inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-2xs font-bold uppercase text-white shadow-sm {hudKlassen(
            key
          )}"
        >
          <span class="size-1.5 rounded-full bg-white/80"></span>
          LIVE
        </span>

        <!-- Dock wie beim Mitglieder-Webplayer (TileDock): Name links,
             rechts Lautstärke (Stumm + Slider + Prozent), Vollbild, X. Die
             Leiste sitzt IMMER sichtbar unter dem Bildrand — native Video-
             Controls wären unter der Leiste begraben und nie klickbar. -->
        <figcaption
          class="from-black/85 via-black/45 absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t to-transparent pt-10 pb-1.5 text-white {hudKlassen(
            key
          )}"
        >
          <div class="flex items-center gap-2 px-2.5">
            <span class="min-w-0 truncate text-xs font-semibold">
              {s ? senderTitel(s) : key}
            </span>
            <div class="ml-auto flex shrink-0 items-center gap-1">
              <div class="flex items-center gap-1.5 rounded-md bg-black/40 px-2 py-1">
                <button
                  type="button"
                  onclick={() => stummUmschalten(key)}
                  class="flex items-center hover:opacity-70"
                  aria-label={v === 0 ? m.tile_shell_unmute() : m.tile_shell_mute()}
                  title={v === 0 ? m.tile_shell_unmute() : m.tile_shell_mute()}
                  data-testid="gast-videos-stumm"
                >
                  {#if v === 0}
                    <VolumeXIcon class="size-3.5" />
                  {:else}
                    <Volume2Icon class="size-3.5" />
                  {/if}
                </button>
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={v}
                  oninput={(e) => volumeSetzen(key, Number((e.currentTarget as HTMLInputElement).value))}
                  class="w-16 accent-white md:w-24"
                  aria-label={m.tile_shell_volume()}
                  data-testid="gast-videos-lautstaerke"
                />
                <span class="w-8 text-right font-mono text-2xs tabular-nums opacity-85 md:hidden">
                  {v}%
                </span>
              </div>
              <button
                type="button"
                onclick={(e) => vollbildUmschalten(key, e.currentTarget as HTMLElement)}
                class="flex items-center justify-center rounded-md p-2 text-white/90 transition-colors hover:bg-white/15"
                aria-label={vollbildKey === key ? m.tile_shell_fullscreen_exit() : m.tile_shell_fullscreen_enter()}
                title={vollbildKey === key ? m.tile_shell_fullscreen_exit() : m.tile_shell_fullscreen_enter()}
                data-testid="gast-videos-vollbild"
              >
                {#if vollbildKey === key}
                  <MinimizeIcon class="size-4" />
                {:else}
                  <MaximizeIcon class="size-4" />
                {/if}
              </button>
              <button
                type="button"
                onclick={() => gastStreams.schliessen(key)}
                class="flex items-center justify-center rounded-md p-2 text-white/90 transition-colors hover:bg-destructive"
                aria-label={m.gast_stream_schliessen()}
                title={m.gast_stream_schliessen()}
                data-testid="gast-videos-schliessen"
              >
                <XIcon class="size-4" />
              </button>
            </div>
          </div>
        </figcaption>
      </figure>
    {/each}

    <!-- Die Spur-Kennung gehört in den Schlüssel: wechselt jemand mitten in
         der Besprechung die Kamera, ist es derselbe Sender mit derselben
         Quelle, aber ein NEUER Track. Ohne sie liefe die Einhäng-Action nicht
         erneut (sie hat keinen Update-Zweig) und die Kachel zeigte weiter das
         alte, stehende Bild. -->
    {#each kamerasImRaster as v (v.identity + v.quelle + (v.track.sid ?? ''))}
      <figure class="border-border shadow-2xl relative min-h-0 w-full min-w-0 overflow-hidden rounded-2xl border bg-black">
        <!-- svelte-ignore a11y_media_has_caption -->
        <video
          class="absolute inset-0 h-full w-full"
          playsinline
          autoplay
          use:anhaengen={v.track}
        ></video>
        <span
          class="bg-primary/15 text-primary absolute top-2 left-2 z-10 inline-flex items-center rounded-md px-2 py-0.5 text-2xs font-semibold uppercase backdrop-blur-sm"
        >
          {v.quelle === 'screen' ? m.gast_kachel_bildschirm() : m.gast_kachel_kamera()}
        </span>
        <figcaption
          class="from-black/85 via-black/45 absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t to-transparent px-3 pt-8 pb-2 text-xs"
        >
          <span class="text-white font-semibold">
            {v.identity.startsWith('user-') ? senderName(v.identity.slice(5)) : v.name}
          </span>
        </figcaption>
      </figure>
    {/each}
  </div>
{/if}
