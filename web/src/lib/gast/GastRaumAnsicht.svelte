<script lang="ts">
  /**
   * Der Raum aus Gastsicht: wer ist da, was läuft, und die drei Knöpfe.
   *
   * Die Knopfreihe bleibt einzeilig (dieselbe Regel wie in der App: fünf runde
   * 56-px-Knöpfe passen auf 390 px nicht nebeneinander) — deshalb sind es
   * hier nur drei.
   */
  import { Button } from '$lib/components/ui/button';
  import { m } from '$lib/paraglide/messages.js';
  import { gastRaum } from './gastRaum.svelte';
  import GastVideoFlaeche from './GastVideoFlaeche.svelte';

  let { titel, community }: { titel: string; community: string } = $props();
</script>

<div class="flex min-h-dvh flex-col">
  <header class="flex items-center justify-between gap-3 border-b px-4 py-3">
    <div class="min-w-0">
      <h1 class="truncate text-base font-semibold">{titel}</h1>
      <p class="text-muted-foreground truncate text-xs">{community}</p>
    </div>
    <span class="text-muted-foreground shrink-0 text-xs">{m.gast_abzeichen()}</span>
  </header>

  <GastVideoFlaeche />

  <section class="flex flex-wrap gap-2 px-4 py-3">
    {#each gastRaum.teilnehmer as t (t.identity)}
      <div
        class="flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm"
        class:ring-2={t.spricht}
        class:ring-primary={t.spricht}
        data-testid="gast-teilnehmer"
      >
        <span class="truncate max-w-40">{t.name}</span>
        {#if t.istGast}
          <span class="text-muted-foreground text-[10px] uppercase">{m.gast_abzeichen()}</span>
        {/if}
        {#if t.stumm}
          <span class="text-muted-foreground text-xs" aria-label={m.gast_stumm()}>×</span>
        {/if}
      </div>
    {/each}
  </section>

  <footer class="mt-auto flex flex-nowrap items-center justify-center gap-3 border-t px-4 py-4">
    <Button
      variant={gastRaum.mikroStumm ? 'secondary' : 'default'}
      onclick={() => gastRaum.mikroUmschalten()}
      data-testid="gast-mikro"
    >
      {gastRaum.mikroStumm ? m.gast_mikro_an() : m.gast_mikro_aus()}
    </Button>
    <Button
      variant={gastRaum.kameraAn ? 'default' : 'secondary'}
      onclick={() => gastRaum.kameraUmschalten()}
      data-testid="gast-kamera"
    >
      {gastRaum.kameraAn ? m.gast_kamera_aus() : m.gast_kamera_an()}
    </Button>
    <Button variant="destructive" onclick={() => gastRaum.verlassen()} data-testid="gast-auflegen">
      {m.gast_auflegen()}
    </Button>
  </footer>
</div>
