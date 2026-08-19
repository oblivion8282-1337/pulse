<script lang="ts">
  /**
   * Kanalname (+ optionale Statusangabe) und das Thema des Kanals in der
   * Kopfzeile — gemeinsam für Text- und Sprachkanäle.
   *
   * Warum eigene Zeile statt `· Thema` hinter dem Namen (2026-08-19): das Thema
   * hing als drittes Bruchstück in derselben Zeile, wurde schon bei mittlerer
   * Länge mitten im Wort abgeschnitten, und beim Sprachkanal standen mit dem
   * Verbindungsstatus sogar ZWEI Bruchstücke hintereinander — das las sich wie
   * eine Kette von Resten statt wie eine Auskunft.
   *
   * Die Kopfzeile behält dabei ihre Höhe (`h-14`): Name (16px) plus Thema
   * (12px, enge Zeilenhöhe) sind zusammen ~40px und passen hinein. Deshalb
   * springt beim Kanalwechsel nichts, obwohl nur manche Kanäle ein Thema haben.
   * Wer das ändert, prüft die Summe nach — sonst wächst die Kopfzeile wieder.
   */
  let {
    name,
    topic = null,
    nameStyle = '',
    meta = ''
  }: {
    name: string;
    /** Thema des Kanals; leer/null → einzeilige Kopfzeile wie ohne Thema. */
    topic?: string | null;
    /** Inline-Style für die Rollenfarbe des Kanalnamens. */
    nameStyle?: string;
    /** Kurze Zusatzangabe neben dem Namen (Sprachkanal: Verbindungsstatus). */
    meta?: string;
  } = $props();
</script>

{#if topic}
  <div class="flex min-w-0 flex-1 flex-col justify-center gap-px">
    <div class="flex min-w-0 items-baseline gap-2.5">
      <span
        class="text-text-bright truncate text-base font-semibold tracking-tight"
        style={nameStyle}
        data-testid="active-channel-name">{name}</span
      >
      {#if meta}
        <span class="text-text-muted hidden shrink-0 truncate text-sm md:block">{meta}</span>
      {/if}
    </div>
    <!-- `title` deckt den Fall ab, der die alte Lösung unbrauchbar machte: ein
         Thema, das für die Breite zu lang ist, bleibt so vollständig lesbar. -->
    <span
      class="text-text-muted truncate text-xs leading-snug"
      title={topic}
      data-testid="channel-topic">{topic}</span
    >
  </div>
{:else}
  <span
    class="text-text-bright truncate text-lg font-semibold tracking-tight"
    style={nameStyle}
    data-testid="active-channel-name">{name}</span
  >
  {#if meta}
    <span class="text-text-muted ml-2 hidden truncate text-sm md:block">· {meta}</span>
  {/if}
{/if}
