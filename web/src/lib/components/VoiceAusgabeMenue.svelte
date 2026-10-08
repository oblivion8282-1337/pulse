<!--
  Ausgabe-Wahl der Sprachleiste (Hörmuschel · Lautsprecher · Bluetooth · AirPlay).

  Aus `VoiceControlBar` herausgezogen (2026-10-08), als der AirPlay-Eintrag
  dazukam: die Leiste lag mit 376 Zeilen schon deutlich über der
  Größen-Policy für Komponenten, und ein weiterer Eintrag hätte sie nur
  weitergeschoben. Verhalten unverändert — dieselben `data-testid`, dieselben
  Klassen, dieselbe Reihenfolge.

  Nur in den Mobil-Hüllen sichtbar; die Weiche bleibt beim Aufrufer
  (`showAudioRouteToggle`), damit es weiter EINE Stelle mit dieser Bedingung
  gibt.

  **Der AirPlay-Eintrag führt aus der App heraus**, anders als die drei
  darüber: er öffnet Apples eigenen Dialog. Das ist Absicht und steht in
  `audioRoute.ts::iosWegZuWahl` begründet — eine App-eigene Geräteliste wäre
  auf iOS eine zweite, schlechtere Bedienung derselben Sache. Geht der Dialog
  nicht auf, erscheint der Hinweis aufs Kontrollzentrum; ein Knopf, der still
  nichts tut, wäre die schlechtere Antwort (Begründung an der nativen Methode).
-->
<script lang="ts">
  import AirplayIcon from '@lucide/svelte/icons/airplay';
  import BluetoothIcon from '@lucide/svelte/icons/bluetooth';
  import EarIcon from '@lucide/svelte/icons/ear';
  import Volume2Icon from '@lucide/svelte/icons/volume-2';
  import { Button } from '$lib/components/ui/button';
  import { m } from '$lib/paraglide/messages.js';
  import { airplayMoeglich, airplayOeffnen, type AudioRoute } from '$lib/platform/audioRoute';
  import { audioRouteState } from '$lib/platform/audioRouteState.svelte';

  let { btnCls, iconCls }: { btnCls: string; iconCls: string } = $props();

  let offen = $state(false);
  /** Gesetzt, wenn Apples Dialog nicht aufging — dann bleibt das Menü offen
   *  und zeigt den Hinweis, statt den Fehlschlag zu verschweigen. */
  let airplayScheitert = $state(false);

  async function umschalten(): Promise<void> {
    offen = !offen;
    if (offen) {
      airplayScheitert = false;
      await audioRouteState.aktualisieren();
    }
  }
  function waehleFestenWeg(r: AudioRoute): void {
    offen = false;
    void audioRouteState.festenWegWaehlen(r);
  }
  async function waehleGeraet(id: number): Promise<void> {
    offen = false;
    await audioRouteState.geraetWaehlen(id);
  }
  async function airplay(): Promise<void> {
    if (await airplayOeffnen()) {
      offen = false;
    } else {
      airplayScheitert = true;
    }
  }

  const eintrag = 'text-text flex w-full items-center gap-2 rounded-lg px-2 py-2 text-sm';
  const aktuell = $derived(audioRouteState.liste?.current);
</script>

<div class="relative">
  {#if offen}
    <!-- Klick-Fänger: Popup schließt bei Tippen daneben. -->
    <button class="fixed inset-0 z-20" aria-label="close" onclick={() => (offen = false)}
    ></button>
  {/if}
  <!-- Kein Tooltip hier: auf dem Handy poppte beim Tippen das
       „Audio-Ausgabe"-Bubble statt der Geräteliste — die Liste selbst
       ist selbsterklärend. -->
  <Button
    variant={aktuell === 'earpiece' ? 'ghost' : 'default'}
    size="icon-sm"
    class={btnCls}
    onclick={umschalten}
    data-testid="voice-audio-route-toggle"
    aria-label={m.voice_bar_route_menu()}
  >
    {#if aktuell === 'earpiece'}<EarIcon class={iconCls} />{:else if aktuell === 'device'}<BluetoothIcon
        class={iconCls}
      />{:else}<Volume2Icon class={iconCls} />{/if}
  </Button>
  {#if offen && audioRouteState.liste}
    <div
      class="bg-bg-panel border-border absolute bottom-full left-1/2 z-30 mb-2 w-52 -translate-x-1/2 rounded-xl border p-1 shadow-lg"
      data-testid="voice-audio-route-menu"
    >
      <button
        class="{eintrag} {aktuell === 'earpiece' ? 'bg-bg-hover font-semibold' : ''}"
        onclick={() => waehleFestenWeg('earpiece')}
      >
        <EarIcon class="size-4" />
        {m.voice_bar_route_name_hoermuschel()}
      </button>
      <button
        class="{eintrag} {aktuell === 'speaker' || aktuell === 'auto'
          ? 'bg-bg-hover font-semibold'
          : ''}"
        onclick={() => waehleFestenWeg('speaker')}
      >
        <Volume2Icon class="size-4" />
        {m.voice_bar_route_name_lautsprecher()}
      </button>
      {#each audioRouteState.liste.devices.filter((d) => d.type.startsWith('BLUETOOTH') || d.type === 'BLE_HEADSET') as d (d.id)}
        <button
          class="{eintrag} {aktuell === 'device' &&
          audioRouteState.liste.currentDeviceId === d.id
            ? 'bg-bg-hover font-semibold'
            : ''}"
          onclick={() => void waehleGeraet(d.id)}
        >
          <BluetoothIcon class="size-4" />
          <span class="truncate"
            >{d.name && d.name.trim() ? d.name : m.voice_bar_route_name_bt()}</span
          >
        </button>
      {/each}
      {#if airplayMoeglich()}
        <button class={eintrag} onclick={() => void airplay()} data-testid="voice-airplay">
          <AirplayIcon class="size-4" />
          {m.voice_bar_route_name_airplay()}
        </button>
        {#if airplayScheitert}
          <p class="text-text-muted px-2 pt-1 pb-2 text-xs">
            {m.voice_bar_route_airplay_fehler()}
          </p>
        {/if}
      {/if}
    </div>
  {/if}
</div>
