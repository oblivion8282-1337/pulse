<script lang="ts">
  /**
   * Die eigene Geräteliste — wer liest mit, und wie werde ich es los
   * (Spec §3b, Punkt 4).
   *
   * **Der Schalter sitzt hier**, wie bei `GeraeteKopplungSection`: bei
   * ausgeschaltetem `E2E_DMS_ENABLED` wird gar nichts gebaut — kein
   * Serveraufruf, nichts sichtbar. Bündel entstehen zwar auch heute schon bei
   * jeder Anmeldung (`krypto/veroeffentlichen.ts` hängt an keinem Schalter),
   * die Liste wäre hinter dem Riegel also nicht leer; solange aber keine
   * Direktnachricht verschlüsselt läuft, gibt es nichts zu widerrufen, und
   * der Zweig muss jederzeit landbar bleiben.
   *
   * **Die Rückfrage vor dem Entfernen ist kein Zierrat.** Der Server lässt
   * das Entfernen jedes Geräts zu, auch des eigenen und auch des letzten —
   * eine Serverregel dagegen wäre nicht durchsetzbar (Begründung in
   * `routes/geraete.py::geraet_ausschliessen`). Die beiden Folgen, die
   * dadurch niemand sonst benennt, stehen deshalb hier: das entfernte Gerät
   * löscht seinen lokalen Verlauf, und ohne teilnahmefähiges Gerät nimmt das
   * Konto keine verschlüsselten Nachrichten mehr an.
   */
  import { onMount } from 'svelte';

  import { keysApi, type EigenesGeraet } from '$lib/api/keys';
  import { serversStore } from '$lib/api/servers.svelte';
  import { Button } from '$lib/components/ui/button';
  import {
    geraeteArt,
    istDiesesGeraet,
    kennungKurz,
    letztesTeilnahmefaehiges
  } from '$lib/krypto/geraeteAnzeige';
  import { geraeteKennung } from '$lib/krypto/geraeteKennung';
  import { E2E_DMS_ENABLED } from '$lib/krypto/schalter';
  import { m } from '$lib/paraglide/messages.js';

  let geraete = $state<EigenesGeraet[]>([]);
  let eigene = $state<string | null>(null);
  let laedt = $state(true);
  let fehler = $state(false);
  /** Die Kennung, für die gerade nachgefragt wird — `null` heisst: keine
   *  offene Rückfrage. Eine Kennung statt eines `boolean`, damit zwei Zeilen
   *  nicht gleichzeitig offen stehen können. */
  let nachfrage = $state<string | null>(null);
  let entferntGerade = $state<string | null>(null);

  function route() {
    return { serverId: serversStore.cloudId() };
  }

  async function laden() {
    laedt = true;
    fehler = false;
    try {
      // Die eigene Kennung zuerst: ohne sie bliebe die Markierung „dieses
      // Gerät" aus, und der Nutzer entschiede blind.
      eigene = await geraeteKennung().catch(() => null);
      geraete = await keysApi.geraete(route());
    } catch {
      fehler = true;
    } finally {
      laedt = false;
    }
  }

  async function entfernen(pubkey: string) {
    entferntGerade = pubkey;
    try {
      await keysApi.geraetEntfernen(pubkey, route());
      await laden();
    } catch {
      fehler = true;
    } finally {
      entferntGerade = null;
      nachfrage = null;
    }
  }

  function datum(iso: string): string {
    return new Date(iso).toLocaleDateString('de-DE', {
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    });
  }

  function artText(g: EigenesGeraet): string {
    const art = geraeteArt(g);
    if (art === 'app') return m.geraete_art_app();
    if (art === 'gekoppelt') return m.geraete_art_gekoppelt();
    return m.geraete_art_browser();
  }

  // `onMount` und kein `$effect`: das Laden hängt von keinem Zustand ab, es
  // soll genau einmal geschehen. Der Riegel steht hier ein zweites Mal, weil
  // das Skript auch dann läuft, wenn das `{#if}` unten nichts baut — ohne ihn
  // gäbe es bei ausgeschaltetem Schalter einen Serveraufruf ohne Anzeige.
  onMount(() => {
    if (E2E_DMS_ENABLED) void laden();
  });
</script>

{#if E2E_DMS_ENABLED}
  <section class="space-y-4" data-testid="geraete-liste">
    <div>
      <h3 class="text-base font-semibold">{m.geraete_liste_title()}</h3>
      <p class="text-sm text-muted-foreground">{m.geraete_liste_description()}</p>
    </div>

    {#if laedt}
      <p class="text-sm text-muted-foreground">{m.geraete_liste_laedt()}</p>
    {:else if fehler}
      <div class="space-y-2">
        <p class="text-sm text-destructive">{m.geraete_liste_fehler()}</p>
        <Button variant="outline" size="sm" onclick={laden}>
          {m.geraete_liste_erneut()}
        </Button>
      </div>
    {:else if geraete.length === 0}
      <p class="text-sm text-muted-foreground">{m.geraete_liste_leer()}</p>
    {:else}
      <ul class="space-y-2">
        {#each geraete as g (g.device_pubkey)}
          {@const selbst = istDiesesGeraet(g.device_pubkey, eigene)}
          <li class="rounded-md border p-3" data-testid="geraete-zeile">
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div class="min-w-0 space-y-1">
                <p class="text-sm font-medium">
                  {artText(g)}
                  {#if selbst}
                    <span class="text-muted-foreground">· {m.geraete_dieses()}</span>
                  {/if}
                  {#if g.verfallen}
                    <span class="text-muted-foreground">· {m.geraete_verfallen()}</span>
                  {/if}
                </p>
                <p class="font-mono text-xs text-muted-foreground">
                  {kennungKurz(g.device_pubkey)}
                </p>
                <p class="text-xs text-muted-foreground">
                  {m.geraete_hinzugefuegt({ datum: datum(g.hinzugefuegt_am) })}
                  · {m.geraete_zuletzt({ datum: datum(g.zuletzt_benutzt) })}
                </p>
              </div>
              {#if nachfrage !== g.device_pubkey}
                <Button
                  variant="outline"
                  size="sm"
                  onclick={() => (nachfrage = g.device_pubkey)}
                  data-testid="geraet-entfernen"
                >
                  {m.geraete_entfernen()}
                </Button>
              {/if}
            </div>

            {#if nachfrage === g.device_pubkey}
              <div class="mt-3 space-y-2 border-t pt-3">
                <p class="text-sm">{m.geraete_entfernen_nachfrage()}</p>
                {#if selbst}
                  <p class="text-sm text-destructive">{m.geraete_entfernen_selbst()}</p>
                {/if}
                {#if letztesTeilnahmefaehiges(geraete, g.device_pubkey)}
                  <p class="text-sm text-destructive">{m.geraete_entfernen_letztes()}</p>
                {/if}
                <div class="flex gap-2">
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={entferntGerade !== null}
                    onclick={() => entfernen(g.device_pubkey)}
                    data-testid="geraet-entfernen-bestaetigen"
                  >
                    {m.geraete_entfernen_bestaetigen()}
                  </Button>
                  <Button variant="ghost" size="sm" onclick={() => (nachfrage = null)}>
                    {m.geraete_entfernen_abbrechen()}
                  </Button>
                </div>
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </section>
{/if}
