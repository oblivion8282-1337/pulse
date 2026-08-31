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
   * Passwort-Änderung und Entfernen sind bewusst KEINE Knöpfe: ändern kann
   * man das Passwort über „Entfernen" + neu einrichten, und Entfernen lässt
   * das Archiv unangetastet im Drive liegen. Mechanik: lib/sicherung.
   */
  import { SICHERUNG_ENABLED } from '$lib/krypto/schalter';
  import { isElectron } from '$lib/platform/runtime';
  import { Button } from '$lib/components/ui/button/index.js';
  import { erzeugePkce } from '$lib/ablage/oauth';
  import { autorisierungsAdresse, tauscheCodeAus } from '$lib/ablage/gdrive';
  import {
    sicherungClient,
    sicherungClientKonfiguriert,
    konsentStarten,
  } from '$lib/sicherung/googleClient';
  import { erzeugeDek, wickleSchluesselDatei, öffneSchluesselDatei } from '$lib/sicherung/krypto';
  import { SCHLUESSEL_DATEI } from '$lib/sicherung/spiegel';
  import { leseSicherungMitSchluessel } from '$lib/sicherung/wiederherstellen';
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
  import {
    sicherungJetztSpuelen,
    sicherungErstsicherung,
  } from '$lib/sicherung/andock';

  let zustand = $state<'pruefe' | 'verbinden' | 'passwort' | 'an'>('pruefe');
  /** Archive existiert schon (anderes Gerät) → Passwort entpackt es. */
  let neuesPasswort = $state(true);
  let passwort = $state('');
  let passwort2 = $state('');
  let meldung = $state('');
  let fehler = $state('');
  let laeuft = $state(false);
  let verbindung = $state<SicherungVerbindung | null>(null);
  let pkce: Awaited<ReturnType<typeof erzeugePkce>> | null = null;

  $effect(() => {
    void (async () => {
      verbindung = await verbindungLesen();
      const entpackt = await dekAusZwischenlager();
      if (verbindung === null) zustand = 'verbinden';
      else zustand = entpackt === null ? 'passwort' : 'an';
      if (verbindung !== null) neuesPasswort = false;
    })();
  });

  function basisVerbindung(weiterleitung: string): SicherungVerbindung {
    const client = sicherungClient();
    return {
      kundenId: client.kundenId,
      ...(client.kundenGeheimnis !== undefined
        ? { kundenGeheimnis: client.kundenGeheimnis }
        : {}),
      weiterleitung,
      ordner: 'Pulse-Sicherung',
      nachspieleToken: verbindung?.nachspieleToken ?? '',
      zugangsToken: verbindung?.zugangsToken,
    };
  }

  async function verbinden(): Promise<void> {
    laeuft = true;
    fehler = '';
    try {
      let weiterleitung = '';
      const code = await konsentStarten(async (r) => {
        weiterleitung = r;
        pkce = await erzeugePkce();
        return autorisierungsAdresse(basisVerbindung(r), pkce!, 'sicherung');
      });
      const zugang = await tauscheCodeAus(basisVerbindung(weiterleitung), code, pkce!);
      verbindung = {
        ...basisVerbindung(weiterleitung),
        nachspieleToken: zugang.nachspieleToken ?? '',
        zugangsToken: zugang.zugangsToken,
      };
      await verbindungSchreiben({ ...verbindung });
      // Vorhandenes Archiv? Dann entpackt das Passwort es, statt ein neues anzulegen.
      const adapter = await adapterLieferant();
      neuesPasswort = (await adapter.lese(SCHLUESSEL_DATEI)) === null;
      zustand = 'passwort';
    } catch (e) {
      fehler = e instanceof Error ? e.message : String(e);
    } finally {
      laeuft = false;
    }
  }

  /** Einmal-Passwort: öffnet das Archiv (oder legt es an) und bringt alles
   *  auf Stand — Erstsicherung rein, Archiv-Bestand in den lokalen Verlauf. */
  async function oeffnen(): Promise<void> {
    laeuft = true;
    fehler = '';
    try {
      let dek: Uint8Array;
      if (neuesPasswort) {
        if (passwort.length < 8 || passwort !== passwort2) {
          throw new Error('Mindestens 8 Zeichen, beide Felder gleich.');
        }
        dek = erzeugeDek();
        await verbindungSchreiben({ ...verbindung! });
        const adapter = await adapterLieferant();
        await adapter.schreibe(SCHLUESSEL_DATEI, await wickleSchluesselDatei(dek, passwort));
      } else {
        const adapter = await adapterLieferant();
        const bytes = await adapter.lese(SCHLUESSEL_DATEI);
        if (bytes === null) throw new Error('Schlüssel-Datei fehlt im Laufwerks-Ordner');
        dek = (await öffneSchluesselDatei(bytes, passwort)).dek;
      }
      await dekZwischenlagern(dek, crypto.randomUUID());
      const gesichert = await sicherungErstsicherung();
      const bestand = await leseSicherungMitSchluessel(await adapterLieferant(), dek);
      meldung = `Aktiv. ${gesichert} Nachrichten gesichert, ${bestand.eintraege.length} aus dem Archiv geladen.`;
      passwort = passwort2 = '';
      zustand = 'an';
    } catch (e) {
      fehler = e instanceof Error ? e.message : String(e);
    } finally {
      laeuft = false;
    }
  }

  async function entfernen(): Promise<void> {
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
        <Button onclick={verbinden} size="sm" disabled={laeuft}>
          {laeuft ? 'Warte auf Google …' : 'Mit Google verbinden'}
        </Button>
        <p class="text-xs text-muted-foreground">
          {isElectron() ? 'Der Browser öffnet sich — Pulse fängt die Rückkehr automatisch ab.' : 'Google öffnet sich in einem neuen Tab; am Ende kommst du hierher zurück.'}
        </p>
      {/if}
    {:else if zustand === 'passwort'}
      <p class="text-sm text-muted-foreground">
        {neuesPasswort ? 'Lege dein Sicherungs-Passwort fest (mindestens 8 Zeichen — gut merken, es gibt keine Wiederherstellung):' : 'Gib dein Sicherungs-Passwort ein:'}
      </p>
      <input class="w-full rounded-md border bg-transparent px-3 py-1.5 text-sm" type="password" bind:value={passwort} />
      {#if neuesPasswort}
        <input class="w-full rounded-md border bg-transparent px-3 py-1.5 text-sm" type="password" placeholder="Wiederholen" bind:value={passwort2} />
      {/if}
      <Button onclick={oeffnen} size="sm" disabled={laeuft || passwort.length === 0}>
        {laeuft ? 'Lädt …' : neuesPasswort ? 'Sicherung aktivieren' : 'Öffnen'}
      </Button>
    {:else}
      <p class="text-sm text-muted-foreground">
        Aktiv — deine Nachrichten werden gesichert.
        {meldung}
      </p>
      <div class="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          onclick={() => void sicherungJetztSpuelen()}
        >Jetzt sichern</Button>
        <button class="text-xs text-destructive hover:underline" onclick={entfernen}>Entfernen</button>
      </div>
    {/if}

    {#if fehler}<p class="text-sm text-destructive">{fehler}</p>{/if}
  {/if}
</div>
