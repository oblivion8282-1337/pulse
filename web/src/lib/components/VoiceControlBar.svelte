<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import { m } from '$lib/paraglide/messages.js';
  import * as Tooltip from '$lib/components/ui/tooltip/index.js';
  import MicIcon from '@lucide/svelte/icons/mic';
  import MicOffIcon from '@lucide/svelte/icons/mic-off';
  import ShieldIcon from '@lucide/svelte/icons/shield';
  import BluetoothIcon from '@lucide/svelte/icons/bluetooth';
  import HeadphonesIcon from '@lucide/svelte/icons/headphones';
  import HeadphoneOffIcon from '@lucide/svelte/icons/headphone-off';
  import PhoneOffIcon from '@lucide/svelte/icons/phone-off';
  import VideoIcon from '@lucide/svelte/icons/video';
  import VideoOffIcon from '@lucide/svelte/icons/video-off';
  import SwitchCameraIcon from '@lucide/svelte/icons/switch-camera';
  import Volume2Icon from '@lucide/svelte/icons/volume-2';
  import EarIcon from '@lucide/svelte/icons/ear';
  import { voice } from '$lib/voice/livekit.svelte';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { channelPermissions } from '$lib/stores/channelPermissions.svelte';
  import { voicePresence } from '$lib/stores/voicePresence.svelte';
  import { currentServerUserId } from '$lib/stores/currentServerUser';
  import { Perm } from '$lib/permissions/bitfield';
  import ScreenShareModeButton from './ScreenShareModeButton.svelte';
  import WatchPartyStartButton from './WatchPartyStartButton.svelte';
  import StreamStatusBar from '$lib/stream/components/StreamStatusBar.svelte';
  import { onMount } from 'svelte';
  import { isCapacitorAndroid } from '$lib/platform/runtime';
  import { audioRouteState } from '$lib/platform/audioRouteState.svelte';
  import { type AudioRoute } from '$lib/platform/audioRoute';

  // Handy-Klasse? Wird vom Mount-Punkt hereingereicht (Geraete-Trennung):
  // Desktop leistet die Leiste im Sidebar-Fuss, Handy als Dock unter dem
  // Panel — dort entfallen die nur-Rechner-Knoepfe (Watch-Party, Bildschirm
  // teilen, Kamera-Wechsler am Tablet).
  let { handy }: { handy: boolean } = $props();

  // Camera-toggle gate: same shape as the HQ-stream button. Hide when
  // the channel's resolved permissions lack USE_VIDEO. Falls back to
  // "allowed" if the channel isn't in the local guild store yet
  // (matches the optimistic-ungated default elsewhere). Note: this is
  // a UI-only gate — voice-signaling currently grants ``can_publish``
  // unconditionally in the LiveKit token, so a determined user could
  // still publish video via DevTools. A backend gate via
  // ``can_publish_sources`` is the proper follow-up.
  // Route-Auswahl-Popup — nur in der Android-App (natives AudioRoute-Plugin).
  // Tippen poppt eine kleine Liste auf: Hörmuschel, Lautsprecher und jedes
  // verbundene Bluetooth-Gerät; die Wahl geht als feste Route ans native
  // Routing. Der Stand lebt im geteilten audioRouteState — Einstellungen und
  // Popup sehen jede Änderung der jeweils anderen Stelle sofort.
  const showAudioRouteToggle = isCapacitorAndroid();
  let routeMenuOffen = $state(false);
  onMount(() => {
    if (!showAudioRouteToggle) return;
    void audioRouteState.aktualisieren();
  });
  async function oeffneRouteMenue(): Promise<void> {
    routeMenuOffen = !routeMenuOffen;
    if (routeMenuOffen) await audioRouteState.aktualisieren();
  }
  function waehleFestenWeg(r: AudioRoute): void {
    routeMenuOffen = false;
    void audioRouteState.festenWegWaehlen(r);
  }
  async function waehleGeraet(id: number): Promise<void> {
    routeMenuOffen = false;
    await audioRouteState.geraetWaehlen(id);
  }

  let canUseCamera = $derived.by(() => {
    const cid = voice.channelId;
    if (!cid) return true;
    const guildId = guilds.guildIdForChannel(cid);
    if (!guildId) return true;
    return channelPermissions.hasChannelPermission(guildId, cid, Perm.USE_VIDEO);
  });

  // Front/back camera flip only makes sense on touch devices (phones/tablets)
  // with two cameras. On desktop — the Electron app or a desktop browser, both
  // mouse-driven — there's no facingMode to toggle, so the button is noise.
  // `pointer: coarse` is true for touch as the primary pointer, false for mouse,
  // regardless of window width (unlike a viewport breakpoint).
  const isTouchDevice =
    typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;

  // Screenshare braucht getDisplayMedia — iPads (Safari UND Chrome iOS)
  // haben die API nicht, Android-Tablets und Desktop schon. Faehigkeits-
  // pruefung statt Bildschirmgrosse: der Knopf taucht nur auf, wo er auch
  // wirklich funktionieren kann. Handys bleiben bewusst raus (Platz).
  const kannBildschirmTeilen =
    typeof window !== 'undefined' &&
    typeof navigator.mediaDevices?.getDisplayMedia === 'function';

  // Gemeinsamer Basiswert für Force-Mute/Deafen-Ableitungen.
  const selfContext = $derived.by(() => {
    const cid = voice.channelId;
    const uid = currentServerUserId();
    return cid && uid ? { cid, uid } : null;
  });

  // Force-mute state for the local user in the current voice channel.
  // The LiveKit token already prevents publish; this flag is purely for
  // disabling the mic-toggle UI + showing the right tooltip so the user
  // sees *why* their mic is locked instead of an opaque silent failure.
  let selfForceMuted = $derived(
    selfContext ? voicePresence.isForceMuted(selfContext.cid, selfContext.uid) : false
  );
  // Server force-deafen: voice.setDeafened is driven from the WS event
  // handler; this flag just disables the toggle so the user can't undeafen
  // themselves until the override is cleared.
  let selfForceDeafened = $derived(
    selfContext ? voicePresence.isForceDeafened(selfContext.cid, selfContext.uid) : false
  );

  // Manueller Lautsprecher/Hörmuschel-Umschalter ENTFERNT (2026-08-25): der
  // native Router routet Voice immer auf den Lautsprecher („Anruf auf
  // Lautsprecher"), ein Hörmuschel-Weg existiert nicht mehr — der Knopf hätte
  // also nichts mehr umgeschaltet.

  // `rounded-full` ausdrücklich: Anruf-Steuerungen sind rund, das ist die
  // Konvention aus jeder Telefon-Oberfläche und keine Abweichung vom Baukasten.
  // Bis zur Design-Vereinheitlichung kam die Rundung unausgesprochen aus der
  // Button-Komponente (die pauschal `rounded-full` war); seit die auf
  // `rounded-md` steht, muss sie hier stehen, wo sie hingehört.
  const btnCls = 'size-14 rounded-full nicht-handy:size-8';
  const iconCls = 'size-6 nicht-handy:size-4';
</script>

<StreamStatusBar />

<!-- `mb-2` NUR auf dem Handy: dort schwebt die Leiste als Dock über der
     Bereichs-Leiste und braucht den Abstand. Am Rechner sitzt dieselbe Leiste
     im Fuss der Seitenspalte, und der Nutzer-Kasten darunter bringt seinen
     Abstand schon selbst mit (`m-2`) — zusammen waren es 16 px, also doppelt
     so viel wie zwischen Stream-Statusleiste und Sprachleiste darüber (8 px
     aus `mt-2`). Die Leiste sass dadurch sichtbar zu hoch. -->
<!-- `bg-bg-input` voll nur mobil (Karten-Design); am Rechner wieder /60 wie vor
     dem Karten-Commit — die solide Fläche las die Leiste im Panel wie ein
     helleres Overlay über den Knöpfen wirken (Nutzerbericht 2026-09-14). -->
<div
  class="border-border bg-bg-input mx-2 mb-2 mt-2 rounded-[14px] border p-2 nicht-handy:mb-0 nicht-handy:bg-bg-input/60 nicht-handy:p-1.5"
  data-testid="voice-control-bar"
>
  <div class="flex items-center gap-1.5 px-1 pb-1.5 text-base nicht-handy:text-xs">
    <span
      class="size-2 shrink-0 rounded-full {voice.connecting ? 'bg-warning' : 'bg-success'}"
      aria-hidden="true"
    ></span>
    <span class="text-text-muted shrink-0">
      {voice.connecting ? m.voice_bar_connecting() : m.voice_bar_label()}
    </span>
    {#if voice.channelName}
      <span class="text-text-bright truncate font-semibold" title={voice.channelName}>
        · {voice.channelName}
      </span>
    {/if}
  </div>

  <!-- `flex-nowrap` + `nicht-handy:gap-0.5`: In der schmalen Seitenpalte (240px minus
       Rand) passten sechs 32px-Knoepfe mit 8px-Luecke nicht — der Auflegen-
       Knopf brach als erster in eine zweite Zeile. Engere Luecke und kein
       Umbruch halten alles in EINER Reihe; mobile Dock-Breite ist locker
       genug, um nichts zu verlieren. -->
  <div class="flex flex-nowrap items-center justify-around gap-2 nicht-handy:justify-between nicht-handy:gap-0.5">
    <Tooltip.Provider delayDuration={300}>
      <Tooltip.Root>
        <Tooltip.Trigger>
          {#snippet child({ props })}
            <Button
              {...props}
              variant={voice.micEnabled && !selfForceMuted ? 'secondary' : 'destructive'}
              size="icon-sm"
              class="{btnCls} relative"
              onclick={() => voice.toggleMic()}
              disabled={selfForceMuted}
              data-testid="voice-mic-toggle"
              aria-label={selfForceMuted
                ? m.voice_bar_force_muted()
                : voice.micEnabled
                  ? m.voice_bar_mic_mute()
                  : m.voice_bar_mic_unmute()}
            >
              {#if voice.micEnabled && !selfForceMuted}<MicIcon class={iconCls} />{:else}<MicOffIcon class={iconCls} />{/if}
              {#if selfForceMuted}
                <ShieldIcon
                  class="absolute right-0.5 bottom-0.5 size-3 fill-amber-400 stroke-bg-input stroke-[2.5]"
                  aria-hidden="true"
                />
              {/if}
            </Button>
          {/snippet}
        </Tooltip.Trigger>
        <Tooltip.Content>
          {#if selfForceMuted}
            {m.voice_bar_force_muted()}
          {:else}
            {voice.micEnabled ? m.voice_bar_mic_state_muted() : m.voice_bar_mic_state_on()}
          {/if}
        </Tooltip.Content>
      </Tooltip.Root>

      <Tooltip.Root>
        <Tooltip.Trigger>
          {#snippet child({ props })}
            <Button
              {...props}
              variant={voice.deafened ? 'destructive' : 'secondary'}
              size="icon-sm"
              class="{btnCls} relative"
              onclick={() => voice.toggleDeafen()}
              disabled={selfForceDeafened}
              data-testid="voice-deafen-toggle"
              aria-label={selfForceDeafened
                ? m.voice_bar_force_deafened()
                : voice.deafened
                  ? m.voice_bar_undeafen()
                  : m.voice_bar_deafen()}
            >
              {#if voice.deafened}<HeadphoneOffIcon class={iconCls} />{:else}<HeadphonesIcon class={iconCls} />{/if}
              {#if selfForceDeafened}
                <ShieldIcon
                  class="absolute right-0.5 bottom-0.5 size-3 fill-amber-400 stroke-bg-input stroke-[2.5]"
                  aria-hidden="true"
                />
              {/if}
            </Button>
          {/snippet}
        </Tooltip.Trigger>
        <Tooltip.Content>
          {#if selfForceDeafened}
            {m.voice_bar_force_deafened()}
          {:else}
            {voice.deafened ? m.voice_bar_deafen_state_on() : m.voice_bar_deafen_state_off()}
          {/if}
        </Tooltip.Content>
      </Tooltip.Root>

      <!-- Watch-Party auf Mobil ausgeblendet — Desktop-Feature (s. Phase 6). -->
      {#if showAudioRouteToggle}
        <!-- Route-Auswahl: Tippen poppt die Geräteliste auf (Hörmuschel,
             Lautsprecher, verbundenes Bluetooth). Nur in der Android-App. -->
        <div class="relative">
          {#if routeMenuOffen}
            <!-- Klick-Fänger: Popup schließt bei Tippen daneben. -->
            <button
              class="fixed inset-0 z-20"
              aria-label="close"
              onclick={() => (routeMenuOffen = false)}
            ></button>
          {/if}
          <!-- Kein Tooltip hier: auf dem Handy poppte beim Tippen das
               „Audio-Ausgabe"-Bubble statt der Geräteliste — die Liste selbst
               ist selbsterklärend. -->
          <Button
            variant={audioRouteState.liste?.current === 'earpiece' ? 'ghost' : 'default'}
            size="icon-sm"
            class={btnCls}
            onclick={oeffneRouteMenue}
            data-testid="voice-audio-route-toggle"
            aria-label={m.voice_bar_route_menu()}
          >
            {#if audioRouteState.liste?.current === 'earpiece'}<EarIcon class={iconCls} />{:else if audioRouteState.liste?.current === 'device'}<BluetoothIcon class={iconCls} />{:else}<Volume2Icon class={iconCls} />{/if}
          </Button>
          {#if routeMenuOffen && audioRouteState.liste}
            <div
              class="bg-bg-panel border-border absolute bottom-full left-1/2 z-30 mb-2 w-52 -translate-x-1/2 rounded-xl border p-1 shadow-lg"
              data-testid="voice-audio-route-menu"
            >
              <button
                class="text-text flex w-full items-center gap-2 rounded-lg px-2 py-2 text-sm {audioRouteState.liste.current === 'earpiece' ? 'bg-bg-hover font-semibold' : ''}"
                onclick={() => waehleFestenWeg('earpiece')}
              >
                <EarIcon class="size-4" />
                {m.voice_bar_route_name_hoermuschel()}
              </button>
              <button
                class="text-text flex w-full items-center gap-2 rounded-lg px-2 py-2 text-sm {audioRouteState.liste.current === 'speaker' || audioRouteState.liste.current === 'auto' ? 'bg-bg-hover font-semibold' : ''}"
                onclick={() => waehleFestenWeg('speaker')}
              >
                <Volume2Icon class="size-4" />
                {m.voice_bar_route_name_lautsprecher()}
              </button>
              {#each audioRouteState.liste.devices.filter((d) => d.type.startsWith('BLUETOOTH') || d.type === 'BLE_HEADSET') as d (d.id)}
                <button
                  class="text-text flex w-full items-center gap-2 rounded-lg px-2 py-2 text-sm {audioRouteState.liste.current === 'device' && audioRouteState.liste.currentDeviceId === d.id ? 'bg-bg-hover font-semibold' : ''}"
                  onclick={() => void waehleGeraet(d.id)}
                >
                  <BluetoothIcon class="size-4" />
                  <span class="truncate">{d.name && d.name.trim() ? d.name : m.voice_bar_route_name_bt()}</span>
                </button>
              {/each}
            </div>
          {/if}
        </div>
      {/if}
      {#if voice.channelId && !handy}
        <WatchPartyStartButton channelId={voice.channelId} />
      {/if}

      {#if canUseCamera}
        <Tooltip.Root>
          <Tooltip.Trigger>
            {#snippet child({ props })}
              <Button
                {...props}
                variant={voice.isCameraOn ? 'default' : 'ghost'}
                size="icon-sm"
                class={btnCls}
                onclick={() => voice.toggleCamera()}
                data-testid="voice-camera-toggle"
                aria-label={voice.isCameraOn ? m.voice_bar_camera_disable() : m.voice_bar_camera_enable()}
              >
                {#if voice.isCameraOn}<VideoIcon class={iconCls} />{:else}<VideoOffIcon class={iconCls} />{/if}
              </Button>
            {/snippet}
          </Tooltip.Trigger>
          <Tooltip.Content>
            {voice.isCameraOn ? m.voice_bar_camera_off() : m.voice_bar_camera_on()}
          </Tooltip.Content>
        </Tooltip.Root>

        <!-- Front-/Rückkamera umschalten — nur auf Touch-Geräten (Handy/Tablet)
             mit zwei Kameras; auf Desktop (App/Browser) sinnlos.
             **Auf dem Handy sitzt er stattdessen auf der eigenen Kachel**
             (`CameraTile`, Entwurf 23a): er betrifft genau dieses Bild, und
             als fuenfter runder 56-px-Knopf spraengte er die einzeilige
             Reihe. Auf dem Tablet ist der Platz da, dort bleibt er hier. -->
        {#if voice.isCameraOn && isTouchDevice && !handy}
          <Tooltip.Root>
            <Tooltip.Trigger>
              {#snippet child({ props })}
                <Button
                  {...props}
                  variant="ghost"
                  size="icon-sm"
                  class={btnCls}
                  onclick={() => voice.flipCamera()}
                  data-testid="voice-camera-flip"
                  aria-label={m.voice_bar_camera_switch()}
                >
                  <SwitchCameraIcon class={iconCls} />
                </Button>
              {/snippet}
            </Tooltip.Trigger>
            <Tooltip.Content>{m.voice_bar_camera_switch_hint()}</Tooltip.Content>
          </Tooltip.Root>
        {/if}
      {/if}

      <!-- Screenshare/HQ — auf Mobil ausgeblendet (kein getDisplayMedia auf iOS/Android) -->
      {#if !handy && kannBildschirmTeilen}
        <ScreenShareModeButton />
      {/if}

      <Tooltip.Root>
        <Tooltip.Trigger>
          {#snippet child({ props })}
            <Button
              {...props}
              variant="destructive"
              size="icon-sm"
              class={btnCls}
              onclick={() => voice.disconnect({ reason: 'user' })}
              data-testid="voice-disconnect"
              aria-label={m.voice_bar_leave()}
            >
              <PhoneOffIcon class={iconCls} />
            </Button>
          {/snippet}
        </Tooltip.Trigger>
        <Tooltip.Content>{m.voice_bar_leave()}</Tooltip.Content>
      </Tooltip.Root>
    </Tooltip.Provider>
  </div>
</div>
