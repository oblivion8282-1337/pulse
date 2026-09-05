<script lang="ts">
  /**
   * Die große Teilnehmer-Kachel des Gastes — die kleine Schwester von
   * ``VoiceParticipantTile`` (deren gast-zweig). Gleiche Gestalt: Glas-Panel,
   * 80-px-Avatar mit Akzentverlauf, Sprech-Glühen mit doppeltem Ping-Ring,
   * LIVE-/CAM-Abzeichen unten am Avatar, Name darunter.
   *
   * Der Unterschied zur Mitglieder-Kachel: Es gibt KEIN Profil dahinter —
   * kein Popover, keine DM, keine Lautstärke. Die beiden Abzeichen sind die
   * einzige Interaktion: LIVE öffnet ALLE Streams dieses Senders (zwei
   * Monitore gehen mit einem Klick beide auf), CAM klappt die Kamera-Kachel
   * im Raster auf/zu.
   */
  import { m } from '$lib/paraglide/messages.js';
  import MicOffIcon from '@lucide/svelte/icons/mic-off';
  import { safeAvatarUrl } from '$lib/avatar';
  import { gastRaum, type GastTeilnehmer } from './gastRaum.svelte';
  import { gastStreams } from './gastStreams.svelte';

  let { t }: { t: GastTeilnehmer } = $props();

  // Profil-Vorzug: Der LiveKit-Name ist der NUTZERNAME, das Profil trägt den
  // Anzeigenamen und das Bild. Fehlt der Eintrag (Profil nie synchronisiert),
  // fällt alles auf LiveKit-Name + Initiale zurück.
  let profil = $derived(
    t.identity.startsWith('user-') ? gastStreams.profile[t.identity.slice(5)] : undefined
  );
  let anzeigeName = $derived(profil?.name ?? t.name);
  let avatarSrc = $derived(safeAvatarUrl(profil?.avatarUrl ?? null));
  let initial = $derived((anzeigeName.trim()[0] ?? '?').toUpperCase());

  /** HQ-Streams dieses Senders — einer (LIVE öffnet direkt) oder mehrere. */
  let streams = $derived(gastStreams.sender.filter((s) => `user-${s.userId}` === t.identity));
  let sendetLive = $derived(streams.length > 0);
  /** Kamera-Kachel dieses Senders (falls er eine veröffentlicht hat). */
  let kamera = $derived(
    gastRaum.videos.find((v) => v.identity === t.identity && v.quelle === 'camera')
  );
  let hatKamera = $derived(!!kamera);

  // Derselbe Glüh-/Ring-Stil wie in der Mitglieder-Kachel: Rot dominiert,
  // Kamera folgt, Sprechen leuchtet in Akzent.
  const BASIS_RING = 'ring-2 ring-offset-2 ring-offset-background';
  let ringKlasse = $derived(
    sendetLive
      ? `${BASIS_RING} ring-red-500`
      : hatKamera
        ? `${BASIS_RING} ring-blue-500`
        : ''
  );

  function badgeKeydown(fn: () => void) {
    return (e: KeyboardEvent) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      e.stopPropagation();
      fn();
    };
  }

  function liveOeffnen(): void {
    for (const s of streams) void gastStreams.ansehen(s.userId, s.slot);
  }
</script>

<div
  class="glass-panel flex shrink-0 flex-col items-center gap-3 rounded-2xl px-6 py-5 text-left"
  data-testid="gast-teilnehmer"
  data-identity={t.identity}
>
  <div class="relative">
    <!-- Sprech-Glühen: immer montiert, blendet weich statt zu poppen —
         identisch zur Mitglieder-Kachel (dort lauert die Lautstärke im
         Glühen; der Gast hat keinen Pegel-Tap, also ein fester Mittelwert). -->
    <div
      class="accent-gradient pointer-events-none absolute -inset-1.5 rounded-full blur-[3px] transition-opacity duration-300"
      style={`opacity: ${t.spricht ? 0.7 : 0};`}
      aria-hidden="true"
    ></div>
    <div
      class="pointer-events-none absolute -inset-2 rounded-full bg-red-500/50 blur-[8px] transition-opacity duration-500"
      style={`opacity: ${sendetLive ? 1 : 0};`}
      aria-hidden="true"
    ></div>
    <div
      class="pointer-events-none absolute -inset-2 rounded-full bg-blue-500/50 blur-[8px] transition-opacity duration-500"
      style={`opacity: ${hatKamera ? 1 : 0};`}
      aria-hidden="true"
    ></div>
    {#if t.spricht}
      <span
        class="border-primary animate-speaking-ping pointer-events-none absolute inset-0 rounded-full border-2"
        aria-hidden="true"
      ></span>
      <span
        class="border-primary animate-speaking-ping pointer-events-none absolute inset-0 rounded-full border-2 [animation-delay:0.7s]"
        aria-hidden="true"
      ></span>
    {/if}
    <div
      class="relative flex size-20 items-center justify-center overflow-hidden rounded-full {ringKlasse}"
    >
      {#if avatarSrc}
        <img src={avatarSrc} alt={anzeigeName} class="size-20 rounded-full object-cover" />
      {:else}
        <span class="accent-gradient text-primary-foreground flex size-20 items-center justify-center rounded-full text-xl font-semibold">
          {initial}
        </span>
      {/if}
    </div>
    {#if sendetLive || hatKamera}
      <div class="absolute -bottom-2 left-1/2 z-10 flex -translate-x-1/2 flex-col items-center gap-1">
        {#if sendetLive}
          <span
            role="button"
            tabindex="0"
            class="bg-badge-live hover:bg-badge-live-hover inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-0.5 text-2xs font-bold uppercase text-white shadow-sm active:scale-95"
            title={m.voice_participant_tile_open_stream_aria({ name: anzeigeName })}
            data-testid="gast-kachel-live"
            onclick={(e) => {
              e.stopPropagation();
              liveOeffnen();
            }}
            onkeydown={badgeKeydown(liveOeffnen)}
          ><span class="size-1.5 rounded-full bg-white/80"></span>LIVE</span>
        {/if}
        {#if hatKamera}
          <span
            role="button"
            tabindex="0"
            class="bg-badge-cam hover:bg-badge-cam-hover inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-0.5 text-2xs font-bold uppercase text-white shadow-sm active:scale-95"
            title={m.voice_participant_tile_open_webcam()}
            data-testid="gast-kachel-cam"
            onclick={(e) => {
              e.stopPropagation();
              if (kamera) gastRaum.kameraImBlickUmschalten(t.identity);
            }}
            onkeydown={badgeKeydown(() => kamera && gastRaum.kameraImBlickUmschalten(t.identity))}
          ><span class="size-1.5 rounded-full bg-white/80"></span>CAM</span>
        {/if}
      </div>
    {/if}
  </div>
  <div class="flex items-center gap-1 text-sm md:text-xs">
    <span
      class="text-text-bright max-w-28 truncate {t.spricht ? 'font-bold' : 'font-semibold'}"
      title={anzeigeName}
    >
      {anzeigeName}
    </span>
    {#if t.istGast}
      <span
        class="text-2xs border-amber-500/60 bg-amber-500/10 text-amber-500 shrink-0 rounded-full border px-1.5 py-0.5 uppercase"
      >
        {m.gast_abzeichen()}
      </span>
    {/if}
    {#if t.stumm}
      <MicOffIcon class="text-destructive size-3.5" aria-label={m.gast_stumm()} />
    {/if}
  </div>
</div>
