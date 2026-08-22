<script lang="ts">
  /**
   * Die rechte Spalte auf dem Tablet, solange nichts gewählt ist.
   *
   * Auf einem Tablet stehen Liste und Inhalt nebeneinander. Ohne diesen
   * Platzhalter bliebe rechts eine leere Fläche stehen, die wie ein Ladefehler
   * aussieht — statt wie „hier erscheint gleich, was du links wählst".
   * Auf dem Handy gibt es die Spalte nicht; der Aufrufer gatet das.
   */
  let { text }: { text: string } = $props();
</script>

<section
  class="glass-panel hidden h-full min-w-0 flex-1 items-center justify-center rounded-none p-8 md:flex md:rounded-2xl"
  data-testid="tablet-placeholder"
>
  <p class="text-text-muted max-w-xs text-center text-sm">{text}</p>
</section>
