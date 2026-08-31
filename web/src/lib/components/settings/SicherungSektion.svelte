<script lang="ts">
  /**
   * Einstellungs-Reiter „Sicherung" — ein Fluss, zwei mögliche Ziele:
   *
   *   1. Ziele hinzufügen: Google Drive (OAuth) und/oder ein lokaler
   *      Ordner (z. B. im Dropbox-/OneDrive-Sync).
   *   2. Sicherungs-Passwort: festlegen (frisches Archiv) oder eingeben
   *      (vorhandenes Archiv eines anderen Geräts).
   *   3. Fertig — bestehende lokale Nachrichten wandern einmalig ins Archiv,
   *      der Archiv-Bestand wird in den lokalen Verlauf geladen, und jede
   *      neue verschlüsselte Nachricht wird in ALLE Ziele gespiegelt.
   *
   * Die Ziele sind unabhängig kombiniert (Multi-Ziel, s. ziele.ts). Das
   * Passwort wird nirgends gespeichert; ändern geht über Entfernen + neu
   * einrichten oder den Re-Wrap-Knopf im Aktiv-Zustand.
   */
  import { SICHERUNG_ENABLED } from '$lib/krypto/schalter';
  import { erzeugeDek, wickleSchluesselDatei, öffneSchluesselDatei } from '$lib/sicherung/krypto';
  import { SCHLUESSEL_DATEI } from '$lib/sicherung/spiegel';
  import {
    adapterLieferant,
    zieleLesen,
    zieleSchreiben,
    zieleLeeren,
    zielEntfernen,
    zieleBesetzt,
    type SicherungZiele,
  } from '$lib/sicherung/ziele';
  import {
    dekAusZwischenlager,
    dekZwischenlagern,
    dekZwischenlagerWischen,
    pufferWischen,
  } from '$lib/sicherung/geraete';
  import { sicherungJetztSpuelen, sicherungErstsicherung, sicherungArchivLaden, sicherungVerwerfen } from '$lib/sicherung/andock';
  import { googleSicherungVerbinden } from '$lib/sicherung/googleClient';
  import { ordnerVerzeichnisWählen, ordnerZugriffErneuern } from '$lib/sicherung/ordner';
  import SicherungZiel from './SicherungZiel.svelte';
  import SicherungFormular from './SicherungFormular.svelte';
  import SicherungAktiv from './SicherungAktiv.svelte';
  import SicherungPasswortAendern from './SicherungPasswortAendern.svelte';

  let zustand = $state<'pruefe' | 'verbinden' | 'passwort' | 'an'>('pruefe');
  /** Archiv existiert schon (anderes Gerät) → Passwort entpackt es. */
  let neuesPasswort = $state(true);
  let meldung = $state('');
  let fehler = $state('');
  let laeuft = $state(false);
  let ziele = $state<SicherungZiele>({});

  $effect(() => {
    void (async () => {
      ziele = await zieleLesen();
      const entpackt = await dekAusZwischenlager();
      const besetzt = zieleBesetzt(ziele);
      if (!besetzt) zustand = 'verbinden';
      else zustand = entpackt === null ? 'passwort' : 'an';
      // Bereits eingerichtet? Dann den Archiv-Bestand automatisch nachladen —
      // der Nutzer will Nachrichten SEHEN, nicht Knöpfe suchen. Probe
      // inklusive: eine tote Verbindung wird hier sichtbar.
      if (zustand === 'an') {
        try {
          await adapterLieferant();
        } catch {
          fehler = 'Ein Ziel ist gerade nicht bedienbar — bitte Verbindung prüfen.';
        }
        void laden();
      }
    })();
  });

  /** Ziel hinzufügen (Google oder Ordner) und den Schlüssel-Stand prüfen. */
  async function zielHinzufügen(ziel: 'gdrive' | 'ordner'): Promise<void> {
    laeuft = true;
    fehler = '';
    sicherungVerwerfen();
    try {
      if (ziel === 'gdrive') {
        ziele.gdrive = await googleSicherungVerbinden();
      } else {
        const verzeichnis = await ordnerVerzeichnisWählen();
        if (verzeichnis === null) {
          laeuft = false;
          return;
        }
        ziele.ordner = { verzeichnis };
      }
      await zieleSchreiben({ ...ziele });
      const adapter = await adapterLieferant();
      neuesPasswort = (await adapter.lese(SCHLUESSEL_DATEI)) === null;
      zustand = 'passwort';
    } catch (e) {
      fehler = e instanceof Error ? e.message : String(e);
    } finally {
      laeuft = false;
    }
  }

  async function laden(): Promise<void> {
    try {
      const anzahl = await sicherungArchivLaden();
      if (anzahl > 0) meldung = `${anzahl} Nachrichten aus dem Archiv geladen.`;
      else meldung = 'Archiv enthält (noch) keine neuen Nachrichten.';
    } catch (e) {
      fehler = 'Archiv-Laden: ' + (e instanceof Error ? e.message : String(e));
    }
  }

  /** Einmal-Passwort: öffnet das Archiv (oder legt es an) und bringt alles
   *  auf Stand — Erstsicherung rein, Archiv-Bestand in den lokalen Verlauf. */
  async function oeffnen(formPasswort: string, formPasswort2: string): Promise<void> {
    laeuft = true;
    fehler = '';
    try {
      let dek: Uint8Array;
      if (neuesPasswort) {
        if (formPasswort.length < 8 || formPasswort !== formPasswort2) {
          throw new Error('Mindestens 8 Zeichen, beide Felder gleich.');
        }
        dek = erzeugeDek();
        await zieleSchreiben({ ...ziele });
        const adapter = await adapterLieferant();
        await adapter.schreibe(SCHLUESSEL_DATEI, await wickleSchluesselDatei(dek, formPasswort));
      } else {
        const adapter = await adapterLieferant();
        const bytes = await adapter.lese(SCHLUESSEL_DATEI);
        if (bytes === null) throw new Error('Schlüssel-Datei fehlt im Archiv-Ordner');
        dek = (await öffneSchluesselDatei(bytes, formPasswort)).dek;
      }
      const kuerzel = (await dekAusZwischenlager())?.kuerzel ?? crypto.randomUUID();
      await dekZwischenlagern(dek, kuerzel);
      sicherungVerwerfen();
      const gesichert = await sicherungErstsicherung();
      await sicherungJetztSpuelen();
      await laden();
      meldung = `Aktiv — ${gesichert} Nachrichten gesichert. ${meldung}`;
      zustand = 'an';
    } catch (e) {
      fehler = e instanceof Error ? e.message : String(e);
    } finally {
      laeuft = false;
    }
  }

  /** Ordner-Zugriff mit Nutzergeste erneuern (Browser fragt sonst nie wieder). */
  async function zugriffErneuern(): Promise<void> {
    if (ziele.ordner === undefined) return;
    const ok = await ordnerZugriffErneuern(ziele.ordner.verzeichnis);
    if (ok) {
      fehler = '';
      zustand = 'an';
      void laden();
    }
  }

  /** Alles entfernen — das Archiv in den Zielen bleibt unangetastet. */
  async function entfernen(): Promise<void> {
    sicherungVerwerfen();
    await zieleLeeren();
    await dekZwischenlagerWischen();
    await pufferWischen();
    ziele = {};
    zustand = 'verbinden';
    meldung = '';
  }
</script>

<div class="space-y-4">
  <h3 class="text-sm font-semibold">Sicherung</h3>

  {#if !SICHERUNG_ENABLED}
    <p class="text-sm text-muted-foreground">Derzeit deaktiviert.</p>
  {:else}
    <p class="text-sm text-muted-foreground">
      Dein verschlüsselter Nachrichten-Verlauf, gespiegelt in deine eigenen
      Ziele. Ohne dein Passwort ist das Archiv für niemanden lesbar.
    </p>

    {#if zustand === 'pruefe'}
      <p class="text-sm text-muted-foreground">Prüfe …</p>
    {:else if zustand === 'verbinden'}
      <SicherungZiel
        laeuft={laeuft}
        gdriveAktiv={ziele.gdrive !== undefined}
        ordnerAktiv={ziele.ordner !== undefined}
        aufGoogle={() => void zielHinzufügen('gdrive')}
        aufOrdner={() => void zielHinzufügen('ordner')}
      />
    {:else if zustand === 'passwort'}
      <SicherungFormular
        neu={neuesPasswort}
        laeuft={laeuft}
        aufOeffnen={oeffnen}
        ordnerModus={ziele.ordner !== undefined}
        aufZugriff={() => void zugriffErneuern()}
      />
    {:else}
      <SicherungAktiv
        meldung={meldung}
        ordnerModus={ziele.ordner !== undefined}
        aufJetztSichern={() => void sicherungJetztSpuelen()}
        aufZugriff={() => void zugriffErneuern()}
        aufEntfernen={entfernen}
      />
      <SicherungPasswortAendern />
    {/if}

    {#if fehler}<p class="text-sm text-destructive">{fehler}</p>{/if}
  {/if}
</div>
