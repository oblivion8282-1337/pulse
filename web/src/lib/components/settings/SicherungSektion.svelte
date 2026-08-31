<script lang="ts">
  /**
   * Einstellungs-Reiter „Sicherung" — absichtlich klein: ein Fluss, drei
   * Schritte, kein Fachvokabular.
   *
   *   1. Mit Google verbinden (oder ist schon).
   *   2. Sicherungs-Passwort: festlegen (frisches Archiv) oder eingeben
   *      (vorhandenes Archiv eines anderen Geräts).
   *   3. Fertig — bestehende lokale Nachrichten wandern einmalig ins Archiv,
   *      der Archiv-Bestand wird in den lokalen Verlauf geladen, und jede
   *      neue verschlüsselte Nachricht wird im Hintergrund gespiegelt.
   *
   * Passwort-Änderung ist ein dezent weggeklickter Re-Wrap
   * (SicherungPasswortAendern — derselbe DEK, kein altes Passwort nötig).
   * Entfernen lässt das Archiv unangetastet im Laufwerk liegen. Mechanik:
   * lib/sicherung.
   */
  import { SICHERUNG_ENABLED } from '$lib/krypto/schalter';
  import { isElectron } from '$lib/platform/runtime';
  import { Button } from '$lib/components/ui/button/index.js';
  import {
    sicherungClientKonfiguriert,
    googleSicherungVerbinden,
  } from '$lib/sicherung/googleClient';
  import { erzeugeDek, wickleSchluesselDatei, öffneSchluesselDatei, entschlüsseleEintrag } from '$lib/sicherung/krypto';
  import { SCHLUESSEL_DATEI } from '$lib/sicherung/spiegel';
  import {
    verbindungLesen,
    verbindungSchreiben,
    verbindungEntfernen,
    adapterLieferant,
    dekAusZwischenlager,
    dekZwischenlagern,
    dekZwischenlagerWischen,
    pufferWischen,
    type SicherungVerbindung,
  } from '$lib/sicherung/geraete';
  import { ordnerVerzeichnisWählen, ordnerZugriffErneuern } from '$lib/sicherung/ordner';
  import { syncOrdnerMoeglich } from '$lib/ablage/syncOrdner';
  import SicherungZiel from './SicherungZiel.svelte';
  import SicherungFormular from './SicherungFormular.svelte';
  import SicherungAktiv from './SicherungAktiv.svelte';
  import SicherungPasswortAendern from './SicherungPasswortAendern.svelte';
  import { sicherungJetztSpuelen, sicherungErstsicherung, sicherungArchivLaden, sicherungVerwerfen } from '$lib/sicherung/andock';

  let zustand = $state<'pruefe' | 'verbinden' | 'passwort' | 'an'>('pruefe');
  /** Archive existiert schon (anderes Gerät) → Passwort entpackt es. */
  let neuesPasswort = $state(true);
  let meldung = $state('');
  let fehler = $state('');
  let laeuft = $state(false);
  let verbindung = $state<SicherungVerbindung | null>(null);

  $effect(() => {
    void (async () => {
      verbindung = await verbindungLesen();
      const entpackt = await dekAusZwischenlager();
      if (verbindung === null) zustand = 'verbinden';
      else zustand = entpackt === null ? 'passwort' : 'an';
      if (verbindung !== null) neuesPasswort = false;
      // Bereits eingerichtet? Dann den Archiv-Bestand automatisch nachladen —
      // der Nutzer will Nachrichten SEHEN, nicht Knöpfe suchen.
      if (zustand === 'an') {
        // Verbindung probehalber benutzen: eine abgelaufene (ohne
        // Refresh-Token) war bisher unsichtbar, weil der Spiegel Fehler
        // stillschweigend schluckt. Hier kostet es eine Zeile Sichtbarkeit.
        try {
          await adapterLieferant();
        } catch {
          fehler =
            'Die Google-Verbindung ist abgelaufen — bitte unten „Entfernen“ und neu verbinden.';
        }
        void laden();
      }
    })();
  });

  async function googleVerbinden(): Promise<void> {
    laeuft = true;
    fehler = '';
    sicherungVerwerfen();
    try {
      verbindung = await googleSicherungVerbinden();
      const adapter = await adapterLieferant();
      neuesPasswort = (await adapter.lese(SCHLUESSEL_DATEI)) === null;
      zustand = 'passwort';
    } catch (e) {
      fehler = e instanceof Error ? e.message : String(e);
    } finally {
      laeuft = false;
    }
  }

  /** Ordner als Ziel: kein OAuth — Verzeichnis wählen, fertig. */
  async function ordnerWählen(): Promise<void> {
    laeuft = true;
    fehler = '';
    sicherungVerwerfen();
    try {
      const verzeichnis = await ordnerVerzeichnisWählen();
      if (verzeichnis === null) return;
      verbindung = { ziel: 'ordner', verzeichnis };
      await verbindungSchreiben({ ...verbindung });
      const adapter = await adapterLieferant();
      neuesPasswort = (await adapter.lese(SCHLUESSEL_DATEI)) === null;
      zustand = 'passwort';
      meldung = neuesPasswort
        ? 'Ordner gewählt. Jetzt das Sicherungs-Passwort festlegen.'
        : 'Archiv im Ordner gefunden — bitte das Sicherungs-Passwort eingeben.';
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
        await verbindungSchreiben({ ...verbindung! });
        const adapter = await adapterLieferant();
        await adapter.schreibe(SCHLUESSEL_DATEI, await wickleSchluesselDatei(dek, formPasswort));
      } else {
        const adapter = await adapterLieferant();
        const bytes = await adapter.lese(SCHLUESSEL_DATEI);
        if (bytes === null) throw new Error('Schlüssel-Datei fehlt im Laufwerks-Ordner');
        dek = (await öffneSchluesselDatei(bytes, formPasswort)).dek;
      }
      // Kennung wiederverwenden, wenn dieses Gerät sie schon hat — sonst
      // splittet jedes Entsperren die eigenen Segmente in neue Namensräume.
      const kuerzel = (await dekAusZwischenlager())?.kuerzel ?? crypto.randomUUID();
      await dekZwischenlagern(dek, kuerzel);
      sicherungVerwerfen(); // Spiegel neu bauen — das Zwischenlager hat gewechselt
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
    if (verbindung?.ziel !== 'ordner') return;
    const ok = await ordnerZugriffErneuern(verbindung.verzeichnis);
    if (ok) {
      fehler = '';
      zustand = 'an';
      void laden();
    }
  }

  async function entfernen(): Promise<void> {
    sicherungVerwerfen(); // laufenden Spiegel stoppen, BEVOR die Datenbanken weg sind
    await verbindungEntfernen();
    await dekZwischenlagerWischen();
    await pufferWischen();
    verbindung = null;
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
      Dein verschlüsselter Nachrichten-Verlauf, gespiegelt in deinen eigenen
      Google Drive. Ohne dein Passwort ist das Archiv für niemanden lesbar.
    </p>

    {#if zustand === 'pruefe'}
      <p class="text-sm text-muted-foreground">Prüfe …</p>
    {:else if zustand === 'verbinden'}
      {#if !sicherungClientKonfiguriert()}
        <p class="text-sm text-muted-foreground">
          Die Sicherung ist in diesem Build nicht konfiguriert.
        </p>
      {:else}
        <SicherungZiel laeuft={laeuft} aufGoogle={googleVerbinden} aufOrdner={ordnerWählen} />
      {/if}
    {:else if zustand === 'passwort'}
      <SicherungFormular
        neu={neuesPasswort}
        laeuft={laeuft}
        aufOeffnen={oeffnen}
        ordnerModus={verbindung?.ziel === 'ordner'}
        aufZugriff={() => void zugriffErneuern()}
      />
    {:else}
      <SicherungAktiv
        meldung={meldung}
        ordnerModus={verbindung?.ziel === 'ordner'}
        aufJetztSichern={() => void sicherungJetztSpuelen()}
        aufZugriff={() => void zugriffErneuern()}
        aufEntfernen={entfernen}
      />
      <SicherungPasswortAendern />
    {/if}

    {#if fehler}<p class="text-sm text-destructive">{fehler}</p>{/if}
  {/if}
</div>
