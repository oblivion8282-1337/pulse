<!--
  „Zurück in den Kanal" — der Weg zur nativen Kanalansicht (nur iOS).

  **Warum es diesen Griff braucht.** Auf iOS hält die Hülle den LiveKit-Raum
  (Grund: die Hörmuschel, Entwurf
  `docs/superpowers/specs/2026-10-10-ios-nativer-sprachweg-design.md`), und
  damit entstehen Kamera- und Bildschirmspuren im nativen Prozess — die WebView
  kann sie nicht anzeigen. Das Bild lebt deshalb in einer nativen Ansicht, die
  über die Oberfläche gelegt wird. Wischt man sie nach unten weg, bleibt man
  verbunden, aber es gibt keinen Weg mehr dorthin: die Kanal-Route darunter
  rendert auf iOS kein Video. Dieser Knopf ist dieser Weg.

  **Eigene Komponente statt eines `{#if}` in der Leiste**, aus zwei Gründen:
  `VoiceControlBar.svelte` liegt schon über der Grössen-Policy für Svelte-
  Komponenten (`PLAN.md` §12.1), und die Bedingung („nativer Weg, Ansicht zu")
  gehört an EINE Stelle — hier. Ausserhalb von iOS rendert die Komponente
  nichts; `voice.nativ` ist dort immer `false`.
-->
<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import * as Tooltip from '$lib/components/ui/tooltip/index.js';
  import Maximize2Icon from '@lucide/svelte/icons/maximize-2';
  import { m } from '$lib/paraglide/messages.js';
  import { voice } from '$lib/voice/livekit.svelte';

  let { btnCls, iconCls }: { btnCls: string; iconCls: string } = $props();
</script>

{#if voice.nativ && !voice.nativeAnsichtOffen}
  <Tooltip.Root>
    <Tooltip.Trigger>
      {#snippet child({ props })}
        <Button
          {...props}
          variant="secondary"
          size="icon-sm"
          class={btnCls}
          onclick={() => voice.ansichtOeffnen()}
          data-testid="voice-native-view-open"
          aria-label={m.voice_bar_native_view_open()}
        >
          <Maximize2Icon class={iconCls} />
        </Button>
      {/snippet}
    </Tooltip.Trigger>
    <Tooltip.Content>{m.voice_bar_native_view_open()}</Tooltip.Content>
  </Tooltip.Root>
{/if}
