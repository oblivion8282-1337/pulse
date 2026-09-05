<script lang="ts">
  /**
   * Vorraum: was für eine Besprechung ist das, wie heisse ich, los.
   *
   * Gestalt wie die Anmeldeseite: Karte auf dem Seitenverlauf, Pulse-Marke
   * obenauf. Bewusst karg — der Gast hat kein Konto, keine Einstellungen und
   * keinen zweiten Bildschirm; alles, was hier steht, muss er in zehn
   * Sekunden verstehen.
   */
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { m } from '$lib/paraglide/messages.js';
  import type { GastInfo } from './api';

  let {
    info,
    laedt,
    fehler,
    onBeitreten
  }: {
    info: GastInfo | null;
    laedt: boolean;
    fehler: string | null;
    onBeitreten: (name: string) => void;
  } = $props();

  let name = $state('');
  let bereit = $derived(name.trim().length > 0 && !laedt && info !== null);

  function fehlerText(schluessel: string): string {
    if (schluessel === 'abgelaufen') return m.gast_fehler_abgelaufen();
    if (schluessel === 'entfernt') return m.gast_fehler_entfernt();
    if (schluessel === 'voll') return m.gast_fehler_voll();
    if (schluessel === 'zufrueh') return m.gast_fehler_zufrueh();
    if (schluessel === 'zuviel') return m.gast_fehler_zuviel();
    return m.gast_fehler_allgemein();
  }
</script>

<div class="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center p-6">
  <div class="bg-card border-border/60 space-y-6 rounded-xl border p-8 shadow-2xl">
    <div class="space-y-2 text-center">
      <img src="/pulse-mark.svg" alt="Pulse" width="56" height="56" class="mx-auto size-14" />
      <h1 class="text-2xl font-semibold">{info?.channel_name ?? m.gast_titel_lade()}</h1>
      {#if info}
        <p class="text-muted-foreground text-sm">{info.guild_name}</p>
      {/if}
      <span
        class="text-2xs border-amber-500/60 bg-amber-500/10 text-amber-500 inline-flex items-center rounded-full border px-2 py-0.5 uppercase"
      >
        {m.gast_abzeichen()}
      </span>
    </div>

    {#if fehler}
      <p
        class="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-sm"
        data-testid="gast-fehler"
      >
        {fehlerText(fehler)}
      </p>
    {/if}

    {#if info}
      <form
        class="space-y-3"
        onsubmit={(e) => {
          e.preventDefault();
          if (bereit) onBeitreten(name.trim());
        }}
      >
        <label class="block space-y-1.5">
          <span class="text-sm font-medium">{m.gast_name_label()}</span>
          <Input
            bind:value={name}
            maxlength={32}
            placeholder={m.gast_name_platzhalter()}
            data-testid="gast-name"
            autocomplete="off"
          />
        </label>
        <Button type="submit" class="w-full" disabled={!bereit} data-testid="gast-beitreten">
          {laedt ? m.gast_verbinde() : m.gast_beitreten()}
        </Button>
        <p class="text-muted-foreground text-center text-xs">{m.gast_hinweis()}</p>
      </form>
    {/if}
  </div>
</div>
