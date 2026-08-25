// Reaktiver Viewport-Store — SSR-sicher (ssr=false, aber trotzdem gegated).
// Bevorzuge CSS-Breakpoints (md:, lg:, max-md:) für rein visuelle Anpassungen;
// diese Klasse nur für konditionelle Logik/Markup (z.B. Drawer-Overlay vs. Spalte).
class Viewport {
  width = $state(typeof window !== 'undefined' ? window.innerWidth : 1280);
  height = $state(typeof window !== 'undefined' ? window.innerHeight : 800);

  get isMobile() {
    return this.width < 768; // < md
  }
  /** Ein Handy bleibt ein Handy, auch quer (844×390): die KURZE Kante verrät
   *  das Gerät. Die mobile Oberfläche (Leisten, Stream-Vollbild, schwebende
   *  Knöpfe) gilt nach dieser Kante — quer ohne Stream bleibt die Ansicht
   *  einfach die gewohnte mobile, nur breiter. */
  get istHandy() {
    return Math.min(this.width, this.height) < 768;
  }
  get isTablet() {
    return this.width >= 768 && this.width < 1024;
  }
  get isDesktop() {
    return this.width >= 1024;
  }

  #inited = false;

  init() {
    if (this.#inited || typeof window === 'undefined') return;
    this.#inited = true;
    const on = () => {
      this.width = window.innerWidth;
      this.height = window.innerHeight;
    };
    window.addEventListener('resize', on, { passive: true });
    on();
  }
}

export const viewport = new Viewport();
