<script lang="ts">
  /**
   * Rückkehr-Station des Google-Konsents (Browser-Weg der Sicherung):
   * Google leitet hierher mit `?code=…`, diese Seite legt den Code in den
   * lokalen Speicher, wo die Einstellungssektion ihn abholt, und sagt dem
   * Nutzer, dass er den Tab schließen kann. Kein weiterer Inhalt.
   *
   * Bughunt Runde 38: ein Anbieter-Fehler-Redirect (`?error=…`, z. B.
   * verweigerte Zustimmung) kam OHNE code und wurde still geschluckt — die
   * Einstellungssektion pollte bis zur 5-Minuten-Frist und meldete dann
   * „Zeit abgelaufen“ statt des echten Grundes. Der Fehler wird jetzt
   * ebenfalls übergeben.
   */
  import { page } from '$app/stores';
  import { OAUTH_RUECKGABE_SPEICHER } from '$lib/sicherung/googleClient';

  $effect(() => {
    const code = $page.url.searchParams.get('code');
    const state = $page.url.searchParams.get('state');
    const fehler = $page.url.searchParams.get('error');
    if ((code !== null || fehler !== null) && state !== null) {
      localStorage.setItem(
        OAUTH_RUECKGABE_SPEICHER,
        JSON.stringify({ state, ...(fehler !== null ? { error: fehler } : { code }) })
      );
      // Best-Effort Selbstschließung: der Tab wurde vom Verbinden-Knopf
      // geöffnet und ist nach der Übergabe nutzlos — wer ihn offen lässt,
      // sammelt Leichen. Schlägt das fehl (nicht skriptgeöffnet), bleibt
      // der Hinweistext.
      setTimeout(() => globalThis.window.close(), 400);
    }
  });

  const codeDa = $derived($page.url.searchParams.get('code') !== null);
  const fehlerDa = $derived($page.url.searchParams.get('error'));
</script>

<div class="mx-auto max-w-md space-y-3 p-8 text-center">
  {#if codeDa}
    <h1 class="text-lg font-semibold">Google verbunden</h1>
    <p class="text-sm text-muted-foreground">
      Der Code wurde übergeben. Dieses Fenster kannst du schließen und in
      Pulse weitermachen.
    </p>
  {:else if fehlerDa}
    <h1 class="text-lg font-semibold">Verbindung abgelehnt</h1>
    <p class="text-sm text-muted-foreground">
      Google meldete: {fehlerDa}. Fenster schließen und in Pulse erneut
      verbinden.
    </p>
  {:else}
    <h1 class="text-lg font-semibold">Fehlende Rückgabe</h1>
    <p class="text-sm text-muted-foreground">
      Diese Seite wird nur von der Google-Anmeldung angesprungen. Bitte starte
      die Verbindung erneut aus den Sicherheitseinstellungen.
    </p>
  {/if}
</div>
