<script lang="ts">
  /**
   * Kanalname (+ optionale Statusangabe) und das Thema des Kanals in der
   * Kopfzeile — gemeinsam für Text- und Sprachkanäle.
   *
   * Einzeilig (2026-08-29): Name und Thema stehen in einer Zeile, gleich
   * groß, das Thema nur farblich gedämpft. Damit springt die Namensgröße
   * nicht mehr, je ob ein Kanal ein Thema hat. Vorgeschichte: 2026-08-19
   * wurde genau dieses Layout zugunsten einer eigenen Thema-Zeile verworfen,
   * weil das Thema als drittes Bruchstück mitten im Wort abgeschnitten
   * wurde; der `title`-Tooltip (volles Thema bei Hover) ist seither die
   * Absicherung dagegen und bleibt.
   */
  let {
    name,
    topic = null,
    nameStyle = '',
    meta = ''
  }: {
    name: string;
    /** Thema des Kanals; leer/null → nur der Name. */
    topic?: string | null;
    /** Inline-Style für die Rollenfarbe des Kanalnamens. */
    nameStyle?: string;
    /** Kurze Zusatzangabe neben dem Namen (Sprachkanal: Verbindungsstatus). */
    meta?: string;
  } = $props();
</script>

<span
  class="text-text-bright truncate text-lg font-semibold tracking-tight"
  style={nameStyle}
  data-testid="active-channel-name">{name}</span
>
{#if topic}
  <!-- `title`: lange Themen bleiben trotz truncate vollständig lesbar. -->
  <span
    class="text-text-muted min-w-0 flex-1 truncate text-lg font-normal tracking-tight"
    title={topic}
    data-testid="channel-topic">· {topic}</span
  >
{/if}
{#if meta}
  <span class="text-text-muted hidden shrink-0 truncate text-sm md:block">· {meta}</span>
{/if}
