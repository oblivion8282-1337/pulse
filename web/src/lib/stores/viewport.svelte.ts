// Reaktiver Viewport-Store — SSR-sicher (ssr=false, aber trotzdem gegated).
// Bevorzuge CSS-Breakpoints (md:, lg:, max-md:) für rein visuelle Anpassungen;
// diese Klasse nur für konditionelle Logik/Markup (z.B. Drawer-Overlay vs. Spalte).
class Viewport {
  width = $state(typeof window !== 'undefined' ? window.innerWidth : 1280);
  height = $state(typeof window !== 'undefined' ? window.innerHeight : 800);

  get isMobile() {
    return this.width < 768; // < md
  }
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

  /**
   * Ein Handy bleibt ein Handy, auch quer (844×390): dort verrät die KURZE
   * Kante das Gerät. Die mobile Oberfläche (Leisten, Stream-Vollbild,
   * schwebende Knöpfe) gilt nach dieser Kante — quer ohne Stream bleibt die
   * Ansicht einfach die gewohnte mobile, nur breiter.
   *
   * **Die kurze Kante allein genügt NICHT**, und das ist der Kern: sie ist am
   * Rechner die Fensterhöhe. Ein maximiertes 1366×768-Notebook hat rund 640 px
   * Innenhöhe, ein Electron-Fenster einmal kleiner gezogen ebenso (Vorgabe
   * 1280×832) — beide gälten als Handy, und das Drei-Spalten-Layout samt
   * Kachel-Leiste und Doppelklick-Vollbild verschwände am Schreibtisch.
   * Deshalb zählt die kurze Kante nur zusammen mit einem Finger als Zeiger.
   *
   * Die Breiten-Bedingung steht bewusst UNVERÄNDERT davor: ein schmales
   * Fenster war schon immer die mobile Ansicht (`isMobile`), daran ändert die
   * Querformat-Erweiterung nichts.
   */
  get istHandy() {
    return this.isMobile || (this.zeigerGrob && Math.min(this.width, this.height) < 768);
  }
  get isTablet() {
    return this.width >= 768 && this.width < 1024;
  }
  get isDesktop() {
    return this.width >= 1024;
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
