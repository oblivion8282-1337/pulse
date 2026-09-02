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
  import { Button } from '$lib/components/ui/button/index.js';
  import { m } from '$lib/paraglide/messages.js';
  import { isElectron } from '$lib/platform/runtime';
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
  import {
    sicherungJetztSpuelen,
    sicherungErstsicherung,
    sicherungArchivLaden,
    sicherungVerwerfen,
    erstsicherungErledigt,
  } from '$lib/sicherung/andock';
  import { googleSicherungVerbinden } from '$lib/sicherung/googleClient';
  import NextcloudVerbinden from '$lib/components/ablage/NextcloudVerbinden.svelte';
  import type { AblageVerbindung } from '$lib/ablage/verbindungen.svelte';
  import { ordnerVerzeichnisWählen, ordnerZugriffErneuern } from '$lib/sicherung/ordner';
  import SicherungZiel from './SicherungZiel.svelte';
  import SicherungFormular from './SicherungFormular.svelte';
  import SicherungPasswortAendern from './SicherungPasswortAendern.svelte';

  let zustand = $state<'pruefe' | 'verbinden' | 'passwort' | 'an' | 'ziel'>('pruefe');
  /** Reinspringen: welches Ziel wird verwaltet. */
  let zielDetail = $state<'gdrive' | 'ordner' | 'nextcloud' | null>(null);
  let nextcloudOffen = $state(false);
  let passwortOffen = $state(false);
  /** Archiv existiert schon (anderes Gerät) → Passwort entpackt es. */
  let neuesPasswort = $state(true);
  let fehler = $state('');
  let laeuft = $state(false);
  let ziele = $state<SicherungZiele>({});
  let nachholNoetig = $state(false);

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
      nachholNoetig = !(await erstsicherungErledigt());
      if (zustand === 'an') {
        try {
          await adapterLieferant();
        } catch {
          fehler = m.sicherung_fehler_ziel_tot();
        }
        void laden();
      }
    })();
  });

  /** Ziel hinzufügen (Google oder Ordner) und den Schlüssel-Stand prüfen. */
  async function zielHinzufügen(ziel: 'gdrive' | 'ordner' | 'nextcloud'): Promise<void> {
    if (ziel === 'nextcloud') {
      nextcloudOffen = true;
      return;
    }
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

  /** Der Freigabe-Link-Dialog hat verbunden: WebDAV-Zugriff als Ziel
   *  übernehmen und in den Passwort-Schritt weiterlaufen. */
  async function nextcloudVerbunden(v: AblageVerbindung): Promise<void> {
    nextcloudOffen = false;
    fehler = '';
    ziele.nextcloud = {
      basis: v.konfiguration.basis ?? '',
      ordner: v.konfiguration.ordner ?? '',
      benutzer: v.konfiguration.benutzer ?? '',
      passwort: v.konfiguration.passwort ?? ''
    };
    try {
      await zieleSchreiben({ ...ziele });
      const adapter = await adapterLieferant();
      neuesPasswort = (await adapter.lese(SCHLUESSEL_DATEI)) === null;
      zustand = 'passwort';
    } catch (e) {
      fehler = e instanceof Error ? e.message : String(e);
    }
  }

  async function laden(): Promise<void> {
    try {
      await sicherungArchivLaden();
      const anzahl = 0;
    } catch (e) {
      fehler = m.sicherung_fehler_archiv_laden({ grund: e instanceof Error ? e.message : String(e) });
    }
  }

  /** Einmal-Passwort: öffnet das Archiv (oder legt es an) und bringt alles
   *  auf Stand — Erstsicherung rein, Archiv-Bestand in den lokalen Verlauf.
   *
   *  **„Aktiv" kommt SOFORT**, sobald Ziel + Schlüssel stehen — die
   *  Erstsicherung läuft im Hintergrund mit Meldung. Vorher blieb der
   *  Knopf während des ganzen Bestands-Uploads auf „Lädt" und die
   *  Verbindung wirkte langsam, obwohl sie längst stand
   *  (Nutzer-Feedback 2026-09-02). */
  async function oeffnen(formPasswort: string, formPasswort2: string): Promise<void> {
    laeuft = true;
    fehler = '';
    try {
      let dek: Uint8Array;
      if (neuesPasswort) {
        if (formPasswort.length < 8 || formPasswort !== formPasswort2) {
          throw new Error(m.sicherung_fehler_passwort_regeln());
        }
        dek = erzeugeDek();
        await zieleSchreiben({ ...ziele });
        const adapter = await adapterLieferant();
        await adapter.schreibe(SCHLUESSEL_DATEI, await wickleSchluesselDatei(dek, formPasswort));
      } else {
        const adapter = await adapterLieferant();
        const bytes = await adapter.lese(SCHLUESSEL_DATEI);
        if (bytes === null) throw new Error(m.sicherung_fehler_schluessel_fehlt());
        dek = (await öffneSchluesselDatei(bytes, formPasswort)).dek;
      }
      const kuerzel = (await dekAusZwischenlager())?.kuerzel ?? crypto.randomUUID();
      await dekZwischenlagern(dek, kuerzel);
      sicherungVerwerfen();
      // Verbindung steht — die Oberfläche löst sich sofort, der Bestands-
      // Upload geht in den Hintergrund (Fortschritt in der Meldung).
      zustand = 'an';
      laeuft = false;
      void (async () => {
        try {
          await sicherungErstsicherung();
          await sicherungJetztSpuelen();
          await sicherungArchivLaden();
        } catch (e) {
          fehler = m.sicherung_fehler_hintergrund({ grund: e instanceof Error ? e.message : String(e) });
        }
      })();
    } catch (e) {
      fehler = e instanceof Error ? e.message : String(e);
      laeuft = false;
    }
  }

  /** Erstsicherung nachreichen: den lokalen Bestand in die Ziele spiegeln. */
  async function erstsicherungNachreichen(): Promise<void> {
    laeuft = true;
    fehler = '';
    try {
      const anzahl = await sicherungErstsicherung();
      nachholNoetig = false;
      await sicherungJetztSpuelen();
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
    passwortOffen = false;
    zielDetail = null;
    zustand = 'verbinden';
  }
</script>

<div class="space-y-4">
  <div class="flex items-center gap-2">
    <h2 class="text-text-bright text-base font-semibold">Sicherung</h2>
    {#if zustand === 'an' || zustand === 'ziel'}
      <span
        class="text-success inline-flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-2xs font-semibold"
        data-testid="sicherung-status"
      >
        {m.sicherung_status_aktiv()}
      </span>
    {:else if zustand !== 'pruefe'}
      <span
        class="text-text-muted inline-flex items-center rounded-full bg-bg-hover px-2 py-0.5 text-2xs font-semibold"
        data-testid="sicherung-status"
      >
        {m.sicherung_status_nicht_aktiv()}
      </span>
    {/if}
    {#if zustand === 'ziel'}
      <Button variant="outline" size="sm" class="ml-auto" onclick={() => (zustand = 'an')} data-testid="sicherung-zurueck">
        ‹ {m.sicherung_zurueck()}
      </Button>
    {/if}
  </div>

  {#if !SICHERUNG_ENABLED}
    <p class="text-sm text-muted-foreground">{m.sicherung_deaktiviert()}</p>
  {:else}
    {#if zustand === 'pruefe'}
      <p class="text-sm text-muted-foreground">{m.sicherung_pruefe()}</p>
    {:else if zustand === 'verbinden'}
      <SicherungZiel
        laeuft={laeuft}
        gdriveAktiv={ziele.gdrive !== undefined}
        ordnerAktiv={ziele.ordner !== undefined}
        nextcloudAktiv={ziele.nextcloud !== undefined}
        aufGoogle={() => void zielHinzufügen('gdrive')}
        aufOrdner={() => void zielHinzufügen('ordner')}
        aufNextcloud={() => zielHinzufügen('nextcloud')}
      />
    {:else if zustand === 'passwort'}
      <SicherungFormular
        neu={neuesPasswort}
        laeuft={laeuft}
        aufOeffnen={oeffnen}
        aufAbbrechen={() => void entfernen()}
        ordnerModus={ziele.ordner !== undefined}
        aufZugriff={() => void zugriffErneuern()}
      />
    {:else if zustand === 'an'}
      {#if nachholNoetig}
        <Button variant="secondary" size="sm" onclick={erstsicherungNachreichen} data-testid="sicherung-nachholen">
          {m.sicherung_aktiv_nachholen()}
        </Button>
      {/if}
      <SicherungZiel
        laeuft={laeuft}
        gdriveAktiv={ziele.gdrive !== undefined}
        ordnerAktiv={ziele.ordner !== undefined}
        nextcloudAktiv={ziele.nextcloud !== undefined}
        aufGoogle={() => void zielHinzufügen('gdrive')}
        aufOrdner={() => void zielHinzufügen('ordner')}
        aufNextcloud={() => zielHinzufügen('nextcloud')}
        aufVerwalten={(z) => {
          zielDetail = z;
          passwortOffen = false;
          zustand = 'ziel';
        }}
      />
      {#if nextcloudOffen}
        <NextcloudVerbinden onVerbunden={(v) => void nextcloudVerbunden(v)} />
      {/if}
    {:else if zustand === 'ziel'}
      <div class="space-y-2">
        <p class="text-text-bright text-sm font-semibold">
          {zielDetail === 'ordner' ? m.sicherung_ziel_ordner() : zielDetail === 'nextcloud' ? 'Nextcloud' : m.sicherung_ziel_gdrive()}
        </p>
        <p class="text-success text-sm">✓ {m.sicherung_ziel_verbunden()}</p>
        {#if zielDetail === 'ordner'}
          <Button variant="secondary" size="sm" onclick={() => void zugriffErneuern()}>
            {m.sicherung_aktiv_zugriff()}
          </Button>
        {:else if !isElectron()}
          <p class="text-xs text-muted-foreground">{m.sicherung_ziel_browser_hinweis()}</p>
        {/if}
      </div>
      <div class="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onclick={() => (passwortOffen = !passwortOffen)}
          data-testid="sicherung-passwort-aendern"
        >
          {m.sicherung_passwort_aendern_link()}
        </Button>
        <Button
          variant="outline"
          size="sm"
          class="border-destructive text-destructive hover:bg-destructive/10"
          onclick={entfernen}
          data-testid="sicherung-entfernen"
        >
          {m.sicherung_aktiv_entfernen()}
        </Button>
      </div>
      {#if passwortOffen}
        <SicherungPasswortAendern />
      {/if}
    {/if}

    {#if fehler}<p class="text-sm text-destructive">{fehler}</p>{/if}
  {/if}
</div>
