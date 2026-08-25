<script lang="ts">
  /**
   * Ein Eintrag der Bereichs-Navigation: Symbol, Zahl, Beschriftung.
   *
   * Handy-Leiste und Tablet-Spalte zeigen dieselben vier Bereiche und
   * unterscheiden sich nur in der Anordnung. `darstellung.svelte.ts` hat
   * bereits die DATEN vereint (Symbole, Woerter, Zahlen); das MARKUP stand
   * danach immer noch zweimal da — Abzeichen-Blase, `data-active`,
   * `aria-current` und die 99+-Kappung wortgleich. Genau der Fall, vor dem die
   * Kommentare in beiden Leisten warnen: man sieht nie beide Groessen
   * gleichzeitig, ein Auseinanderlaufen faellt also nicht auf.
   *
   * Was sich wirklich unterscheidet, sind die Klassen des Verweises selbst
   * (waagerecht gegen senkrecht, andere Hervorhebung) — die bringt jede Leiste
   * ueber `class` mit.
   */
  import type { Bereich } from '$lib/navigation/tabs';
  import {
    SYMBOLE,
    beschriftung,
    zahlFuer,
    zahlBeschriftung
  } from '$lib/navigation/darstellung.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { safeAvatarUrl } from '$lib/avatar';

  let {
    bereich,
    istAktiv,
    class: klasse,
    zeigeBeschriftung = true,
    symbolGroesse,
    ziel
  }: {
    bereich: Bereich;
    istAktiv: boolean;
    /** Klassen des `<a>` — der einzige echte Unterschied der beiden Leisten. */
    class: string;
    /** Handy-Leiste ohne Wörter: nur Symbol, Beschriftung als screen-reader-
        Text. Die Symbole werden dafuer etwas groesser gezogen. */
    zeigeBeschriftung?: boolean;
    /** Optionale eigene Symbolgroesse (z. B. schmalere Tablet-Spalte);
        Default: 23px mit / 40px ohne Beschriftung. */
    symbolGroesse?: string;
    /** Überschreibt das Link-Ziel (bereich.href) — z. B. zeigt der Räume-Tab
        bei aktiver Voice-Verbindung direkt auf den Room, in dem man steckt. */
    ziel?: string;
  } = $props();

  let Symbol = $derived(SYMBOLE[bereich.id]);
  /** Der Du-Bereich zeigt statt des Symbols das Profilbild des angemeldeten
   *  Accounts — das Icon bleibt der Fallback für Accounts ohne Bild. */
  let avatarUrl = $derived(
    bereich.id === 'me' ? safeAvatarUrl(auth.user?.avatar_url) : null
  );
  let zahl = $derived(zahlFuer(bereich.id));
  let ripple: HTMLSpanElement | null = $state(null);

  /** Einmalige Ping-Welle beim Antippen — startet die Ripple-Animation
   * neu, auch wenn sie schon läuft (Klassen-Reset + Reflow). */
  function ping() {
    if (!ripple) return;
    ripple.classList.remove('tab-ripple-run');
    void ripple.offsetWidth;
    ripple.classList.add('tab-ripple-run');
  }
</script>

<a
  href={ziel ?? bereich.href}
  class={klasse}
  data-testid={`tab-${bereich.id}`}
  data-active={istAktiv}
  aria-current={istAktiv ? 'page' : undefined}
  onclick={ping}
>
  <span class="relative flex items-center justify-center">
    <!-- **Der Sonar-Ping.** Die Bildmarke von Pulse ist ein Ping: konzentrische
         Ringe, die von einem Punkt ausgehen (`static/pulse-mark.svg`). Der
         aktive Bereich sitzt deshalb in genau dieser Form statt in einem
         Allerwelts-Pillenhintergrund — sie taucht auf jedem Bildschirm auf und
         macht die Leiste unverwechselbar, ohne laut zu sein.
         Beim Antippen läuft EINE Ping-Welle weg (tab-ripple, unten in
         app.css) — dieselbe Geste wie die Sprech-Anzeige im Chat, nur
         ausgelöst durch die Fingerbewegung statt durch Audio. -->
    {#if istAktiv}
      <span class="pointer-events-none absolute inset-0 flex items-center justify-center" aria-hidden="true">
        <span class="border-primary/25 absolute {zeigeBeschriftung ? 'size-[38px]' : 'size-[56px]'} rounded-full border"></span>
        <span class="border-primary/45 absolute {zeigeBeschriftung ? 'size-[30px]' : 'size-[46px]'} rounded-full border"></span>
        <span class="bg-primary/12 absolute {zeigeBeschriftung ? 'size-[30px]' : 'size-[46px]'} rounded-full"></span>
      </span>
    {/if}
    {#if avatarUrl}
      <img
        src={avatarUrl}
        alt={beschriftung(bereich.id)}
        class="relative rounded-full object-cover {symbolGroesse ??
          (zeigeBeschriftung ? 'size-[23px]' : 'size-[40px]')}"
      />
    {:else}
      <Symbol
        class="relative {symbolGroesse ??
          (zeigeBeschriftung ? 'size-[23px]' : 'size-[40px]')}"
      />
    {/if}
    <span
      bind:this={ripple}
      class="border-primary/50 pointer-events-none absolute size-[56px] rounded-full border-2 opacity-0"
      aria-hidden="true"
    ></span>
    {#if zahl > 0}
      <span
        class="bg-badge-count absolute -right-2 -top-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-extrabold leading-none text-white"
        data-testid={`tab-badge-${bereich.id}`}
        aria-label={zahlBeschriftung(bereich.id, zahl)}
      >{zahl > 99 ? '99+' : zahl}</span>
    {/if}
  </span>
  {#if zeigeBeschriftung}
    {beschriftung(bereich.id)}
  {:else}
    <span class="sr-only">{beschriftung(bereich.id)}</span>
  {/if}
</a>
