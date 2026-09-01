<script lang="ts">
  /**
   * Die "noch kein Laufwerk verbunden"-Aufforderung — derselbe Ablauf stand
   * bisher zweimal hingeschrieben: einmal in `CommunityDateiablage.svelte`
   * fuer das Community-Laufwerk, einmal in `KanalDateiablageVerbinden.svelte`
   * fuer ein Kanal-Laufwerk. Beide zeigen dieselbe Karte, oeffnen denselben
   * `NextcloudVerbinden`-Ablauf und melden denselben Fehlerzustand — nur der
   * Hinweistext, die `data-testid`-Vorsilbe und was nach dem Verbinden
   * serverseitig passiert (Guild- vs. Kanal-Route) unterscheiden sich. Diese
   * Unterschiede bleiben beim Aufrufer: `onVerbunden` bekommt die neue
   * Verbindung und liefert eine Fehlermeldung zurueck (oder `null` bei
   * Erfolg) — das haelt die serverseitige Logik dort, wo sie hingehoert.
   */
  import { Button } from '$lib/components/ui/button/index.js';
  import NextcloudVerbinden from './NextcloudVerbinden.svelte';
  import type { AblageVerbindung } from '$lib/ablage/verbindungen.svelte.ts';

  let {
    testIdPraefix,
    hinweisText,
    fehlerTestId,
    onVerbunden,
  }: {
    testIdPraefix: string;
    hinweisText: string;
    /** Nur `KanalDateiablageVerbinden` markiert die Fehlerzeile bisher mit
     *  einem eigenen `data-testid` — `CommunityDateiablage` nicht. Ohne
     *  dieses Attribut bleibt die Zeile unmarkiert, wie zuvor. */
    fehlerTestId?: string;
    onVerbunden: (v: AblageVerbindung) => Promise<string | null>;
  } = $props();

  let verbindenOffen = $state(false);
  let fehler = $state('');

  async function nachVerbindung(v: AblageVerbindung): Promise<void> {
    verbindenOffen = false;
    fehler = '';
    const fehlermeldung = await onVerbunden(v);
    if (fehlermeldung) fehler = fehlermeldung;
  }
</script>

<div class="rounded-lg border border-dashed p-6 text-center" data-testid="{testIdPraefix}-aufforderung">
  <p class="mb-3 text-sm text-muted-foreground">{hinweisText}</p>
  <Button onclick={() => (verbindenOffen = true)} data-testid="{testIdPraefix}-verbinden">
    Laufwerk verbinden
  </Button>
</div>
{#if verbindenOffen}
  <div class="mt-3">
    <NextcloudVerbinden onVerbunden={nachVerbindung} />
  </div>
{/if}
{#if fehler}
  <p class="mt-2 text-sm text-destructive" data-testid={fehlerTestId}>{fehler}</p>
{/if}
