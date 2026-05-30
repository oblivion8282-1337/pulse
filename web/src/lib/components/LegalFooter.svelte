<script lang="ts">
  import { m } from '$lib/paraglide/messages.js';
  // Dezente Rechts-Buttons für den unteren Fensterrand der Auth-Seiten.
  // Adaptiv: auf Mobil/in-flow über Theme-Tokens (hell & dunkel lesbar), ab md
  // über dem dunklen Desktop-Verlauf in heller „Glas"-Optik.
  const links = $derived([
    { href: '/impressum', label: m.legal_footer_impressum() },
    { href: '/datenschutz', label: m.legal_footer_datenschutz() },
    { href: '/agb', label: m.legal_footer_agb() },
  ]);
</script>

<nav class="flex flex-wrap items-center justify-center gap-2" aria-label={m.legal_footer_nav_label()}>
  {#each links as link (link.href)}
    <a
      href={link.href}
      class="border-border/40 text-muted-foreground/80 hover:bg-muted/40 hover:text-foreground
             rounded-full border px-3 py-1 text-xs transition-colors
             md:border-white/[0.08] md:bg-white/[0.03] md:text-white/45 md:hover:bg-white/[0.08] md:hover:text-white/80"
    >
      {link.label}
    </a>
  {/each}
</nav>
