<script lang="ts">
  /**
   * Rückkehr-Station des Google-Konsents (Browser-Weg der Sicherung):
   * Google leitet hierher mit `?code=…`, diese Seite legt den Code in den
   * lokalen Speicher, wo die Einstellungssektion ihn abholt, und sagt dem
   * Nutzer, dass er den Tab schließen kann. Kein weiterer Inhalt.
   */
  import { page } from '$app/stores';
  import { OAUTH_CODE_SPEICHER } from '$lib/sicherung/googleClient';

  $effect(() => {
    const code = $page.url.searchParams.get('code');
    if (code !== null) {
      localStorage.setItem(OAUTH_CODE_SPEICHER, code);
    }
  });

  const codeDa = $derived($page.url.searchParams.get('code') !== null);
</script>

<div class="mx-auto max-w-md space-y-3 p-8 text-center">
  {#if codeDa}
    <h1 class="text-lg font-semibold">Google verbunden</h1>
    <p class="text-sm text-muted-foreground">
      Der Code wurde übergeben. Dieses Fenster kannst du schließen und in
      Pulse weitermachen.
    </p>
  {:else}
    <h1 class="text-lg font-semibold">Fehlende Rückgabe</h1>
    <p class="text-sm text-muted-foreground">
      Diese Seite wird nur von der Google-Anmeldung angesprungen. Bitte starte
      die Verbindung erneut aus den Sicherheitseinstellungen.
    </p>
  {/if}
</div>
