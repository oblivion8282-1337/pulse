<script lang="ts">
  /**
   * Emoji-Picker — die FUENF Einbauorte (Composer, Nachrichten-Reaktionen,
   * Watch-Party-Chat, Nachrichten-Aktionen, Design-Galerie) kennen nur diese
   * Komponente und ihr `onPick(emoji)`-Interface; dahinter arbeitet
   * [Emoji Mart](https://github.com/missive/emoji-mart) (v5, Web-Komponente).
   *
   * **Warum eine Bibliothek.** Der bisherige Eigenbau zeigte 8 Kategorie-
   * Knoepfe, die nicht ins 288px-Kaestchen passten, nur englische Suche und
   * keine „zuletzt benutzt“-Liste. Emoji Mart bringt den vollstaendigen
   * Unicode-Katalog, Suche und „Haeufig benutzt“ mit — Beschriftungen über
   * Paraglide in der aktiven Sprache. Und, fuer spaeter: eigene Emojis pro
   * Guild als eigene Kategorie (`custom`-Prop, IDEAS.md „Custom Emoji +
   * Sticker“).
   *
   * **Daten + Bibliothek werden traege geladen** (`import()` — eigener
   * Chunk, erst beim ersten Öffnen), und aus dem Bundle heraus gehostet:
   * nichts wird von einem CDN nachgeladen (Self-Hosting-Grundsatz).
   *
   * **Suche:** Emoji Mart durchsucht die englischen Namen/Schlüsselwörter
   * des Katalogs — deutlich breiter als bisher, aber nicht deutschsprachig
   * (dafür müsste ein CLDR-lokalisiertes Datenset mitgehostet werden;
   * Rückfalloption, nicht gebaut).
   */
  import { onMount } from 'svelte';
  import { m } from '$lib/paraglide/messages.js';

  let { onPick }: { onPick: (emoji: string) => void } = $props();

  let anker = $state<HTMLDivElement | null>(null);
  let fehler = $state(false);

  /** Beschriftungen des Pickers — über Paraglide in der aktiven Sprache
   *  (de/en), zur Öffnungszeit aufgelöst. Die Suchbegriffe selbst kommen
   *  aus den Katalogdaten, s. Modulkopf. */
  const beschriftungen = () => ({
    categories: {
      frequent: m.emoji_picker_cat_frequent(),
      people: m.emoji_picker_cat_people(),
      nature: m.emoji_picker_cat_nature(),
      foods: m.emoji_picker_cat_foods(),
      activity: m.emoji_picker_cat_activity(),
      places: m.emoji_picker_cat_places(),
      objects: m.emoji_picker_cat_objects(),
      symbols: m.emoji_picker_cat_symbols(),
      flags: m.emoji_picker_cat_flags(),
    },
    search: m.emoji_picker_search_label(),
    search_no_results_1: m.emoji_picker_no_results_1(),
    search_no_results_2: m.emoji_picker_no_results_2(),
    pick: m.emoji_picker_pick(),
    add_custom: m.emoji_picker_add_custom(),
    categories_label: m.emoji_picker_categories_label(),
    skins: { choose: m.emoji_picker_skins_choose(), change: m.emoji_picker_skins_change() },
  });

  onMount(() => {
    let abgebrochen = false;
    let angehaengt: HTMLElement | null = null;

    (async () => {
      try {
        // Beides träge: Data-JSON (~350 KB gzipped) und die Bibliothek landen
        // in eigenen Chunks und laden erst, wenn der Picker das erste Mal
        // geöffnet wird.
        const [{ default: daten }, { Picker }] = await Promise.all([
          import('@emoji-mart/data'),
          import('emoji-mart'),
        ]);
        if (abgebrochen || !anker) return;

        // Emoji Mart v5: der Konstruktor nimmt das Props-Objekt (es landet in
        // `this.props` und wird in connectedCallback mit den Defaults
        // gemischt). Der Klick-Callback heißt **onEmojiSelect** — es gibt
        // kein emoji-click-DOM-Event (0 Vorkommen im Paket; der erste Versuch
        // hing an genau diesem Phantom-Namen). onEmojiSelect bekommt die
        // vollen Emoji-Daten; uns interessiert `native`.
        const picker = new Picker({
          data: daten,
          i18n: beschriftungen(),
          onEmojiSelect: (emoji: { native: string }) => onPick(emoji.native),
          // Auto folgt der OS-Einstellung; Pulse schaltet seine .dark-Klasse
          // nach Nutzerwunsch — der Picker liest daher die ANGEWANDTE Klasse
          // zum Öffnungszeitpunkt.
          theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
          set: 'native',
          previewPosition: 'none',
        });
        angehaengt = picker as unknown as HTMLElement;
        anker.appendChild(picker as unknown as HTMLElement);
      } catch (e) {
        console.error('[emoji-picker] Laden fehlgeschlagen:', e);
        if (!abgebrochen) fehler = true;
      }
    })();

    return () => {
      abgebrochen = true;
      angehaengt?.remove();
    };
  });
</script>

<div
  class="overflow-hidden rounded-2xl border border-border shadow-xl backdrop-blur-xl"
  data-testid="emoji-picker"
  role="dialog"
  aria-label={m.emoji_picker_dialog_label()}
>
  {#if fehler}
    <p class="p-3 text-sm text-muted-foreground">{m.emoji_picker_load_failed()}</p>
  {:else}
    <div bind:this={anker} class="emoji-mart-anker"></div>
  {/if}
</div>

<style>
  /* Der Picker lebt im Shadow-DOM und regelt seine Breite selbst
     (~350px); der Anker hält nur die Stelle offen. */
  .emoji-mart-anker:empty {
    min-height: 360px;
    min-width: 320px;
  }
</style>
