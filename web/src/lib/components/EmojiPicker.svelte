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
   * Unicode-Katalog, deutsche Beschriftungen, Suche und „Haeufig benutzt“
   * mit — und, fuer spaeter: eigene Emojis pro Guild als eigene Kategorie
   * (`custom`-Prop, IDEAS.md „Custom Emoji + Sticker“).
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

  /** Beschriftungen auf Deutsch — Form des emoji-mart-i18n-Objekts
   *  (Kategorienamen, Suche, Buttons). Suchbegriffe selbst kommen aus den
   *  Katalogdaten, s. Modulkopf. */
  const DEUTSCH = {
    categories: {
      frequent: 'Häufig benutzt',
      people: 'Smileys & Leute',
      nature: 'Tiere & Natur',
      foods: 'Essen & Trinken',
      activity: 'Aktivitäten',
      places: 'Reisen & Orte',
      objects: 'Objekte',
      symbols: 'Symbole',
      flags: 'Flaggen',
    },
    search: 'Suchen',
    search_no_results_1: 'Mh.',
    search_no_results_2: 'Kein Emoji gefunden',
    pick: 'Emoji auswählen…',
    add_custom: 'Eigenes Emoji hinzufügen',
    categories_label: 'Kategorien',
    skins: { choose: 'Hautton wählen', change: 'Hautton ändern' },
  };

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

        const picker = new Picker({
          data: daten,
          i18n: DEUTSCH,
          // Auto folgt der OS-Einstellung; Pulse schaltet seine .dark-Klasse
          // nach Nutzerwunsch — der Picker liest daher die ANGEWANDTE Klasse
          // zum Öffnungszeitpunkt.
          theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
          set: 'native',
          previewPosition: 'none',
        });
        // Der EINE Auslöser: das emoji-click-DOM-Event der Web-Komponente.
        // (Zusätzliches onEmojiClick als Option wäre ein zweiter Pfad —
        // doppeltes Einfügen.) Der Bibliotheks-Typ des Pickers deklariert
        // die DOM-Seite nicht — daher der Doppel-Cast über HTMLElement.
        const element = picker as unknown as HTMLElement;
        element.addEventListener('emoji-click', (klick: Event) => {
          const emoji = (klick as CustomEvent<{ emoji: { native: string } }>).detail?.emoji;
          if (emoji?.native) onPick(emoji.native);
        });
        angehaengt = element;
        anker.appendChild(element);
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
    <p class="p-3 text-sm text-muted-foreground">Emoji-Auswahl konnte nicht geladen werden.</p>
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
