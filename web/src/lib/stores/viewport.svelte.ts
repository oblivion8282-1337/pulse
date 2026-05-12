// Reaktiver Viewport-Store — SSR-sicher (ssr=false, aber trotzdem gegated).
// Bevorzuge CSS-Breakpoints (md:, lg:, max-md:) für rein visuelle Anpassungen;
// diese Klasse nur für konditionelle Logik/Markup (z.B. Drawer-Overlay vs. Spalte).
class Viewport {
  width = $state(typeof window !== 'undefined' ? window.innerWidth : 1280);

  get isMobile() {
    return this.width < 768; // < md
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
    const on = () => (this.width = window.innerWidth);
    window.addEventListener('resize', on, { passive: true });
    on();
  }
}

export const viewport = new Viewport();
