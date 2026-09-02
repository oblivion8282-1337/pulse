<script lang="ts">
  /**
   * Das Passwort-Wechsel-Formular im Aktiv-Zustand: zwei Felder + Speichern;
   * der Knopf liegt in der Übersicht. Eigenständig, damit die Sektion unter der
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
  import { m } from '$lib/paraglide/messages.js';
  import CheckIcon from '@lucide/svelte/icons/check';
  import XIcon from '@lucide/svelte/icons/x';
  import { wickleSchluesselDatei, öffneSchluesselDatei } from '$lib/sicherung/krypto';
  import { SCHLUESSEL_DATEI } from '$lib/sicherung/spiegel';
  import { adapterLieferant, dekAusZwischenlager, dekZwischenlagern } from '$lib/sicherung/geraete';

  let altPasswort = $state('');
  let passwort = $state('');
  let passwort2 = $state('');

  const reichlich = $derived(passwort.length >= 8);
  const gleich = $derived(passwort2.length > 0 && passwort === passwort2);
  const gueltig = $derived(reichlich && gleich);
  let laeuft = $state(false);
  let fehler = $state('');
  let meldung = $state('');

  async function aendern(): Promise<void> {
    laeuft = true;
    fehler = '';
    meldung = '';
    try {
      if (passwort.length < 8 || passwort !== passwort2) {
        throw new Error(m.sicherung_fehler_passwort_regeln());
      }
      const adapter = await adapterLieferant();
      // Das bisherige Passwort wird am Archiv verifiziert, und der DEK kommt
      // AUS DEM ARCHIV (nicht aus dem Geräte-Zwischenlager): Der neue Umschlag
      // umhüllt garantiert denselben DEK wie der alte — nur wer das bisherige
      // Passwort kennt, darf ihn neu verschließen.
      const bytes = await adapter.lese(SCHLUESSEL_DATEI);
      if (bytes === null) throw new Error(m.sicherung_fehler_schluessel_fehlt());
      let dek: Uint8Array;
      try {
        dek = (await öffneSchluesselDatei(bytes, altPasswort)).dek;
      } catch {
        throw new Error(m.sicherung_passwort_alt_falsch());
      }
      await adapter.schreibe(SCHLUESSEL_DATEI, await wickleSchluesselDatei(dek, passwort));
      // Gerät frisch bestücken, falls das Zwischenlager leer war.
      const gelagert = await dekAusZwischenlager();
      await dekZwischenlagern(dek, gelagert?.kuerzel ?? crypto.randomUUID());
      meldung = m.sicherung_meldung_passwort_geaendert();
      altPasswort = '';
      passwort = '';
      passwort2 = '';
    } catch (e) {
      fehler = e instanceof Error ? e.message : String(e);
    } finally {
      laeuft = false;
    }
  }
</script>

  <div class="space-y-2">
    <input
      class="w-full rounded-md border bg-transparent px-3 py-1.5 text-sm"
      type="password"
      placeholder={m.sicherung_passwort_alt()}
      bind:value={altPasswort}
    />
    <input
      class="w-full rounded-md border bg-transparent px-3 py-1.5 text-sm"
      type="password"
      placeholder={m.sicherung_passwort_neu2()}
      bind:value={passwort}
    />
    <input
      class="w-full rounded-md border bg-transparent px-3 py-1.5 text-sm"
      type="password"
      placeholder={m.sicherung_passwort_wiederholen()}
      bind:value={passwort2}
    />
    <ul class="space-y-1 text-xs" data-testid="sicherung-passwort-checkliste">
      <li class="flex items-center gap-1.5 {reichlich ? 'text-success' : 'text-muted-foreground'}">
        {#if reichlich}<CheckIcon class="size-3.5" />{:else}<XIcon class="size-3.5" />{/if}
        {m.sicherung_passwort_zeichen({ n: passwort.length })}
      </li>
      {#if passwort2.length > 0}
        <li class="flex items-center gap-1.5 {gleich ? 'text-success' : 'text-muted-foreground'}">
          {#if gleich}<CheckIcon class="size-3.5" />{:else}<XIcon class="size-3.5" />{/if}
          {m.sicherung_passwort_gleich()}
        </li>
      {/if}
    </ul>
    <Button onclick={aendern} size="sm" disabled={laeuft || altPasswort.length === 0 || !gueltig}>
      {laeuft ? m.sicherung_laebt() : m.sicherung_passwort_speichern()}
    </Button>
    {#if meldung}<p class="text-sm text-muted-foreground">{meldung}</p>{/if}
    {#if fehler}<p class="text-sm text-destructive">{fehler}</p>{/if}
  </div>
