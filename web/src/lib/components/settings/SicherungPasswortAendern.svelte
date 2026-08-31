<script lang="ts">
  /**
   * Passwort-Änderung der Sicherung als Re-Wrap: derselbe DEK, neues Salt
   * und neue Nonce — das Archiv im Laufwerk bleibt bytegleich, nur die
   * Schlüssel-Datei wird neu geschrieben. Eigenständig, damit die
   * Sicherungs-Sektion unter der Komponenten-Größen-Policy bleibt.
   */
  import { Button } from '$lib/components/ui/button/index.js';
  import { öffneSchluesselDatei, wickleSchluesselDatei } from '$lib/sicherung/krypto';
  import { SCHLUESSEL_DATEI } from '$lib/sicherung/spiegel';
  import { adapterLieferant } from '$lib/sicherung/geraete';

  let altesPasswort = $state('');
  let neu = $state('');
  let neu2 = $state('');
  let fehler = $state('');
  let meldung = $state('');
  let laeuft = $state(false);

  async function aendern(): Promise<void> {
    if (altesPasswort.length === 0 || neu.length < 8 || neu !== neu2) {
      fehler = 'Altes Passwort und neues Passwort (mindestens 8 Zeichen, zweimal gleich) eingeben.';
      return;
    }
    laeuft = true;
    fehler = '';
    try {
      const adapter = await adapterLieferant();
      const bytes = await adapter.lese(SCHLUESSEL_DATEI);
      if (bytes === null) throw new Error('Schlüssel-Datei fehlt im Laufwerks-Ordner');
      const { dek } = await öffneSchluesselDatei(bytes, altesPasswort);
      await adapter.schreibe(SCHLUESSEL_DATEI, await wickleSchluesselDatei(dek, neu));
      altesPasswort = neu = neu2 = '';
      meldung = 'Passwort geändert — das Archiv selbst ist unangetastet.';
    } catch (e) {
      fehler = e instanceof Error ? e.message : String(e);
    } finally {
      laeuft = false;
    }
  }
</script>

<div class="space-y-2">
  <input class="w-full rounded-md border bg-transparent px-3 py-1.5 text-sm" type="password" placeholder="Altes Sicherungs-Passwort" bind:value={altesPasswort} />
  <input class="w-full rounded-md border bg-transparent px-3 py-1.5 text-sm" type="password" placeholder="Neues Sicherungs-Passwort" bind:value={neu} />
  <input class="w-full rounded-md border bg-transparent px-3 py-1.5 text-sm" type="password" placeholder="Neues Passwort wiederholen" bind:value={neu2} />
  <Button onclick={aendern} variant="secondary" size="sm" disabled={laeuft}>Passwort ändern</Button>
  {#if meldung}<p class="text-xs text-muted-foreground">{meldung}</p>{/if}
  {#if fehler}<p class="text-sm text-destructive">{fehler}</p>{/if}
</div>
