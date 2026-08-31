<script lang="ts">
  /**
   * Der dezente Passwort-Wechsel im Aktiv-Zustand: erst ein Text-Link, dann
   * zwei Felder + Speichern. Eigenständig, damit die Sektion unter der
   * Komponenten-Policy bleibt; die Logik liegt hier, weil sie einen eigenen,
   * engen Fehler-Umfang hat (die Sektion kennt nur Öffnen und Entfernen).
   *
   * Passwort-Änderung = nur Re-Wrap (`wickleSchluesselDatei`): derselbe DEK,
   * neues Salt, neue Nonce — das Archiv bleibt bytegleich. Ein altes Passwort
   * ist nicht nötig, denn der DEK liegt im gerätelokalen Zwischenlager
   * (`dekAusZwischenlager`); fehlt er dort, kann dieses Gerät das Archiv
   * ohnehin nicht öffnen und der Nutzer muss erst wieder freischalten.
   */
  import { Button } from '$lib/components/ui/button/index.js';
  import { wickleSchluesselDatei } from '$lib/sicherung/krypto';
  import { SCHLUESSEL_DATEI } from '$lib/sicherung/spiegel';
  import { adapterLieferant, dekAusZwischenlager } from '$lib/sicherung/geraete';

  let offen = $state(false);
  let passwort = $state('');
  let passwort2 = $state('');
  let laeuft = $state(false);
  let fehler = $state('');
  let meldung = $state('');

  async function aendern(): Promise<void> {
    laeuft = true;
    fehler = '';
    meldung = '';
    try {
      if (passwort.length < 8 || passwort !== passwort2) {
        throw new Error('Mindestens 8 Zeichen, beide Felder gleich.');
      }
      const gelagert = await dekAusZwischenlager();
      if (gelagert === null) {
        throw new Error(
          'Der Schlüssel liegt nicht mehr auf diesem Gerät — bitte erst öffnen oder die Sicherung neu verbinden.',
        );
      }
      const adapter = await adapterLieferant();
      await adapter.schreibe(SCHLUESSEL_DATEI, await wickleSchluesselDatei(gelagert.dek, passwort));
      meldung = 'Passwort geändert — ab jetzt mit dem neuen öffnen (auch auf anderen Geräten).';
      passwort = '';
      passwort2 = '';
    } catch (e) {
      fehler = e instanceof Error ? e.message : String(e);
    } finally {
      laeuft = false;
    }
  }
</script>

{#if !offen}
  <button class="text-xs text-muted-foreground hover:underline" onclick={() => (offen = true)}>
    Passwort ändern
  </button>
{:else}
  <div class="space-y-2">
    <p class="text-sm text-muted-foreground">
      Neues Passwort festlegen (mindestens 8 Zeichen — es gibt keine
      Wiederherstellung). Das Archiv selbst bleibt unverändert:
    </p>
    <input
      class="w-full rounded-md border bg-transparent px-3 py-1.5 text-sm"
      type="password"
      bind:value={passwort}
    />
    <input
      class="w-full rounded-md border bg-transparent px-3 py-1.5 text-sm"
      type="password"
      placeholder="Wiederholen"
      bind:value={passwort2}
    />
    <Button onclick={aendern} size="sm" disabled={laeuft || passwort.length === 0}>
      {laeuft ? 'Lädt …' : 'Passwort speichern'}
    </Button>
    {#if meldung}<p class="text-sm text-muted-foreground">{meldung}</p>{/if}
    {#if fehler}<p class="text-sm text-destructive">{fehler}</p>{/if}
  </div>
{/if}
