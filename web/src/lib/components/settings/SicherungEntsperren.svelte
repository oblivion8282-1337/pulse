<script lang="ts">
  /**
   * Der Passwort-Auftritt der Sicherung — Schlüssel-Datei im Laufwerk
   * entpacken, DEK gerätelokal zwischengelagern. Vom Hauptteil
   * (SicherungSektion) getrennt, weil beide gegen die Größen-Policy gehen.
   */
  import { Button } from '$lib/components/ui/button/index.js';
  import {
    öffneSchluesselDatei,
  } from '$lib/sicherung/krypto';
  import { SCHLUESSEL_DATEI } from '$lib/sicherung/spiegel';
  import { adapterLieferant, dekZwischenlagern } from '$lib/sicherung/geraete';

  const { aufEntsperrt } = $props<{ aufEntsperrt: () => void }>();

  let passwort = $state('');
  let fehler = $state('');
  let laeuft = $state(false);

  async function entsperren(): Promise<void> {
    if (!passwort || laeuft) return;
    laeuft = true;
    fehler = '';
    try {
      const adapter = await adapterLieferant();
      const bytes = await adapter.lese(SCHLUESSEL_DATEI);
      if (bytes === null) throw new Error('Schlüssel-Datei fehlt im Laufwerks-Ordner');
      const { dek } = await öffneSchluesselDatei(bytes, passwort);
      const kuerzel = crypto.randomUUID();
      await dekZwischenlagern(dek, kuerzel);
      passwort = '';
      aufEntsperrt();
    } catch (e) {
      fehler = e instanceof Error ? e.message : String(e);
    } finally {
      laeuft = false;
    }
  }
</script>

<div class="space-y-2">
  <p class="text-sm text-muted-foreground">
    Dieses Gerät hat den Sicherungs-Schlüssel noch nicht entpackt. Gib dein
    Sicherungs-Passwort einmal ein — es wird nirgends gespeichert.
  </p>
  <input
    class="w-full rounded-md border bg-transparent px-3 py-1.5 text-sm"
    type="password"
    placeholder="Sicherungs-Passwort"
    bind:value={passwort}
    onkeydown={(e) => e.key === 'Enter' && entsperren()}
  />
  {#if fehler}<p class="text-sm text-destructive">{fehler}</p>{/if}
  <Button onclick={entsperren} variant="secondary" size="sm" disabled={laeuft || !passwort}>
    {laeuft ? 'Entpacke …' : 'Entpacken'}
  </Button>
</div>
