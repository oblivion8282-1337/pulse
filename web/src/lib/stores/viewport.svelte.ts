// Reaktiver Viewport-Store — SSR-sicher (ssr=false, aber trotzdem gegated).
//
// **Der Vertrag: drei Geräteklassen, saubere Trennung (2026-09-04).**
// `desktop`, `tablet` und `handy` schliessen sich gegenseitig aus und decken
// jeden Fall ab — entschieden am GERAET (Desktop-App, Zeigertyp, kurze
// Bildschirmkante), nie an der Fensterbreite. Die Breite darf INNERHALB einer
// Klasse verkleinern (Spalten schrumpfen, per CSS-Breakpoint etwas ausblenden),
// aber nie die Klasse wechseln: ein schmales Fenster am Rechner bleibt die
// Desktop-Anordnung, ein quer gedrehtes Handy bleibt die Handy-Anordnung.
//
// * Klasse pruefen → diese Getter (`isMobile` / `istHandy` / `isTablet` /
//   `isDesktop`). Nie `width` mit einer Schwelle vergleichen.
// * CSS-Breakpoints (`md:` / `lg:` / `max-md:`) nur für Groesse-Feinjustierung
//   innerhalb der eigenen Klasse — nie, um die Anordnung einer ANDEREN Klasse
//   nachzubauen (das war die Falle, in der `GuildRail` bis 2026-09-04 hing).
// * Die Rechnung selbst: `geraetKlasse.ts` (importfrei, in `pnpm test:unit`
//   geprueft). Diese Klasse hier ist nur ihre reaktive Huelle.
import { isElectron } from '$lib/platform/runtime';
import { geraetKlasse, type GeraetKlasse } from './geraetKlasse';

class Viewport {
  width = $state(typeof window !== 'undefined' ? window.innerWidth : 1280);
  height = $state(typeof window !== 'undefined' ? window.innerHeight : 800);

  /**
   * Grober Zeiger = Finger. `(pointer: coarse)` beschreibt den PRIMÄREN
   * Zeiger, ein Notebook mit Touchscreen und Maus bleibt also `fine`.
   *
   * Reaktiv gehalten, obwohl sich der Wert im Betrieb praktisch nie ändert:
   * er wird vor `init()` gelesen (Komponenten rendern früher), und ein
   * einmal falsch eingefrorener Wert wäre nicht mehr zu korrigieren.
   */
  zeigerGrob = $state(
    typeof window !== 'undefined'
      ? (window.matchMedia?.('(pointer: coarse)').matches ?? false)
      : false
  );

  /** Die Geräteklasse dieses Geräts — die EINE Quelle fuer alle vier
   *  Sichtbarkeits-Getter darunter. Reaktiv über `zeigerGrob` und die
   *  Fenstermaße; die Klasse selbst wechselt im Betrieb nur, wenn ein Tablet
   *  angedockt/abgedockt wird (Zeigerwechsel), nie durch Fensterresizen. */
  get geraet(): GeraetKlasse {
    return geraetKlasse(
      isElectron(),
      this.zeigerGrob,
      Math.min(this.width, this.height)
    );
  }

  /** Handy-Klasse (Finger, kurze Kante < 768) — auch quer (844×390). Die
   *  mobile Oberfläche (Vollbild-Listen, Drawer, Karten, Bereichs-Leiste
   *  unten) haengt an diesem Zeichen. */
  get isMobile() {
    return this.geraet === 'handy';
  }

  /** Deutsche Bezeichnung derselben Klasse wie `isMobile`. Beide Namen sind
   *  im Code seit je im Gebrauch (Voice/Stream/Mobile nutzen `istHandy`,
   *  Chat/Routen `isMobile`) — sie meinen exakt dasselbe, die Partition
   *  kennt nur ein „handy". */
  get istHandy() {
    return this.geraet === 'handy';
  }

  /** Tablet-Klasse (Finger, kurze Kante >= 768): Liste und Detail nebenein-
   *  ande, Navigation als `TabletNavRail`-Spalte links statt Leiste unten. */
  get isTablet() {
    return this.geraet === 'tablet';
  }

  /** Desktop-Klasse: Desktop-App oder Maus-/Trackpad-Zeiger. Bleibt auch im
   *  schmalsten Fenster die Desktop-Anordnung (Rail, Spalten, Member-Liste
   *  nach eigenem Feinverhalten) — Breite veraendert sie nicht. */
  get isDesktop() {
    return this.geraet === 'desktop';
  }

  #inited = false;
  #read() {
    this.width = window.innerWidth;
    this.height = window.innerHeight;
  }
  /** Android-WebView: `resize` feuert bei Drehung manchmal gar nicht oder
   *  liefert noch die ALTEN Maße (innerWidth/innerHeight hinken dem physischen
   *  Drehen um Frames hinterher). Deshalb wird nach jedem Event mehrfach
   *  verzögert neu gelesen, bis die Werte stabil sind. */
  #scheduleReread() {
    for (const delay of [60, 200, 450]) {
      setTimeout(() => this.#read(), delay);
    }
  }
  init() {
    if (this.#inited || typeof window === 'undefined') return;
    this.#inited = true;
    const on = () => {
      this.#read();
      this.#scheduleReread();
    };
    window.addEventListener('resize', on, { passive: true });
    window.addEventListener('orientationchange', on, { passive: true });
    // matchMedia feuert zuverlässig, wenn die Orientierung die (Breiten-)
    // MediaQuery-Klasse wechselt — zweites Netz neben `resize`.
    window.matchMedia('(orientation: landscape)').addEventListener('change', on);
    window.visualViewport?.addEventListener('resize', on, { passive: true });
    // Der Zeigertyp wechselt, wenn ein Tablet angedockt/abgedockt wird oder
    // eine Maus dazukommt — selten, aber dann soll die Oberfläche folgen.
    const grob = window.matchMedia?.('(pointer: coarse)');
    grob?.addEventListener('change', (e) => (this.zeigerGrob = e.matches));
    if (grob) this.zeigerGrob = grob.matches;
    on();
  }
}

export const viewport = new Viewport();
