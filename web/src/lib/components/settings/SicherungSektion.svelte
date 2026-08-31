<script lang="ts">
  /**
   * Settings-Sektion „Sicherung" — Spiegelung des verschlüsselten
   * Verlaufs ins eigene Google-Laufwerk. Drei Zustände: nicht eingerichtet
   * (Google verbinden + Passwort setzen), Passwort nötig (dieses Gerät hat
   * den Schlüssel noch nicht entpackt), aktiv (Status, Jetzt sichern,
   * Passwort ändern, Wiederherstellen, Entfernen).
   *
   * Die Passphrase wird nirgends gespeichert — sie leitet nur einmal den
   * Schlüssel ab, der das Archiv öffnet (lib/sicherung). Google sieht nur
   * verschlüsselte Segmente; der Server sieht gar nichts.
   */
  import { SICHERUNG_ENABLED } from '$lib/krypto/schalter';
  import { isElectron } from '$lib/platform/runtime';
  import { Button } from '$lib/components/ui/button/index.js';
  import { erzeugePkce } from '$lib/ablage/oauth';
  import {
    autorisierungsAdresse,
    tauscheCodeAus,
    auffrischeZugang,
    gdriveAdapter,
  } from '$lib/ablage/gdrive';
  import {
    sicherungClient,
    sicherungClientKonfiguriert,
    konsentStarten,
  } from '$lib/sicherung/googleClient';
  import { erzeugeDek, wickleSchluesselDatei, öffneSchluesselDatei } from '$lib/sicherung/krypto';
  import { SCHLUESSEL_DATEI } from '$lib/sicherung/spiegel';
  import {
    verbindungLesen,
    verbindungSchreiben,
    verbindungEntfernen,
    anbindungAusVerbindung,
    adapterLieferant,
    dekZwischenlagern,
    dekAusZwischenlager,
    dekZwischenlagerWischen,
    pufferWischen,
    type SicherungVerbindung,
  } from '$lib/sicherung/geraete';
  import { sicherungJetztSpuelen } from '$lib/sicherung/andock';
  import SicherungEntsperren from './SicherungEntsperren.svelte';
  import SicherungWiederherstellen from './SicherungWiederherstellen.svelte';

  let zustand = $state<'pruefe' | 'neu' | 'passwort' | 'aktiv'>('pruefe');
  let passwort = $state('');
  let passwort2 = $state('');
  let altesPasswort = $state('');
  let fehler = $state('');
  let meldung = $state('');
  let laeuft = $state(false);
  let pkce = $state<Awaited<ReturnType<typeof erzeugePkce>> | null>(null);
  let verbindung = $state<SicherungVerbindung | null>(null);

  $effect(() => {
    void (async () => {
      verbindung = await verbindungLesen();
      const entpackt = await dekAusZwischenlager();
      zustand = verbindung === null ? 'neu' : entpackt === null ? 'passwort' : 'aktiv';
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
    };
  }

  async function verbinden(): Promise<void> {
    laeuft = true;
    fehler = '';
    try {
      // Die Weiterleitung entscheidet der Konsent-Fluss selbst (Electron:
      // dynamischer Loopback-Port vom Main, Browser: Rückkehr-Route) — der
      // Token-Tausch muss exakt dieselbe tragen, darum merken wir sie uns.
      // `konsentStarten` liefert den nackten Zugangs-Code.
      let genutzteWeiterleitung = '';
      const code = await konsentStarten(async (weiterleitung) => {
        genutzteWeiterleitung = weiterleitung;
        pkce = await erzeugePkce();
        return autorisierungsAdresse(basisVerbindung(weiterleitung), pkce, 'sicherung');
      });
      const zugang = await tauscheCodeAus(
        basisVerbindung(genutzteWeiterleitung),
        code,
        pkce!,
      );
      verbindung = { ...basisVerbindung(genutzteWeiterleitung), nachspieleToken: zugang.nachspieleToken ?? '' };
      meldung = 'Google verbunden. Jetzt das Sicherungs-Passwort setzen.';
    } catch (e) {
      fehler = e instanceof Error ? e.message : String(e);
    } finally {
      laeuft = false;
    }
  }

  async function einrichten(): Promise<void> {
    if (!verbindung || passwort.length < 8) {
      fehler = 'Passwort zu kurz — mindestens 8 Zeichen.';
      return;
    }
    if (passwort !== passwort2) {
      fehler = 'Passwörter stimmen nicht überein.';
      return;
    }
    laeuft = true;
    fehler = '';
    try {
      const dek = erzeugeDek();
      const verpackt = await wickleSchluesselDatei(dek, passwort);
      const zugang = await auffrischeZugang(anbindungAusVerbindung(verbindung), verbindung.nachspieleToken);
      const adapter = gdriveAdapter({ zugangsToken: zugang.zugangsToken, ordner: verbindung.ordner });
      await adapter.schreibe(SCHLUESSEL_DATEI, verpackt);
      await dekZwischenlagern(dek, crypto.randomUUID());
      // Ebene Kopie: `verbindung` ist eine $state-Variable, deren Proxy die
      // IndexedDB mit "could not be cloned" abweist — der Spread liefert
      // ein schlichtes Objekt aus Grundwerten.
      await verbindungSchreiben({ ...verbindung });
      passwort = passwort2 = '';
      zustand = 'aktiv';
      meldung = 'Sicherung aktiv — neue Nachrichten werden gespiegelt.';
    } catch (e) {
      fehler = e instanceof Error ? e.message : String(e);
    } finally {
      laeuft = false;
    }
  }

  async function passwortÄndern(): Promise<void> {
    // Re-Wrap: derselbe DEK, neues Salt/Nonce — das Archiv im Laufwerk
    // bleibt bytegleich, nur die Schlüssel-Datei wird neu geschrieben.
    if (altesPasswort.length === 0 || passwort.length < 8 || passwort !== passwort2) {
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
      await adapter.schreibe(SCHLUESSEL_DATEI, await wickleSchluesselDatei(dek, passwort));
      altesPasswort = passwort = passwort2 = '';
      meldung = 'Passwort geändert — das Archiv selbst ist unangetastet.';
    } catch (e) {
      fehler = e instanceof Error ? e.message : String(e);
    } finally {
      laeuft = false;
    }
  }
</script>

<div class="space-y-4">
  <h3 class="text-sm font-semibold">Sicherung</h3>

  {#if !SICHERUNG_ENABLED}
    <p class="text-sm text-muted-foreground">Derzeit deaktiviert.</p>
    {/if}
    {#if SICHERUNG_ENABLED && zustand === 'pruefe'}
      <p class="text-sm text-muted-foreground">Prüfe …</p>
    {:else if SICHERUNG_ENABLED && zustand === 'neu'}
      {#if !sicherungClientKonfiguriert()}
        <p class="text-sm text-muted-foreground">
          Die Sicherung ist in diesem Build nicht konfiguriert
          (VITE_SICHERUNG_GDRIVE_KUNDEN_ID fehlt beim Bau).
        </p>
      {:else}
        <p class="text-sm text-muted-foreground">
          Spiegelt deinen verschlüsselten Verlauf in deinen eigenen Google Drive.
          Ohne dein Passwort — und ohne uns — ist das Archiv unlesbar.
        </p>
        <div class="flex flex-wrap items-center gap-2">
          <Button onclick={verbinden} size="sm" disabled={laeuft}>
            {laeuft ? 'Warte auf Google …' : 'Mit Google verbinden'}
          </Button>
          <span class="text-xs text-muted-foreground">
            {isElectron() ? 'Der Browser öffnet sich — Pulse fängt die Rückkehr automatisch ab.' : 'Google öffnet sich in einem neuen Tab; am Ende kommst du hierher zurück.'}
          </span>
        </div>
        {#if verbindung !== null}
          <input class="w-full rounded-md border bg-transparent px-3 py-1.5 text-sm" type="password" placeholder="Sicherungs-Passwort (mindestens 8 Zeichen)" bind:value={passwort} />
          <input class="w-full rounded-md border bg-transparent px-3 py-1.5 text-sm" type="password" placeholder="Passwort wiederholen" bind:value={passwort2} />
          <Button onclick={einrichten} size="sm" disabled={laeuft}>{laeuft ? 'Richte ein …' : 'Sicherung aktivieren'}</Button>
        {/if}
      {/if}
    {:else if zustand === 'passwort'}
      <SicherungEntsperren aufEntsperrt={() => (zustand = 'aktiv')} />
    {:else}
      <p class="text-sm text-muted-foreground">
        Aktiv — Ordner „{verbindung?.ordner}". Nachrichten werden im Hintergrund gespiegelt.
      </p>
      <div class="flex flex-wrap gap-2">
        <Button onclick={() => void sicherungJetztSpuelen()} variant="secondary" size="sm">Jetzt sichern</Button>
        <Button onclick={() => (zustand = 'passwort')} variant="secondary" size="sm">Auf diesem Gerät entsperren</Button>
        <Button
          variant="secondary"
          size="sm"
          onclick={async () => {
            await verbindungEntfernen();
            await dekZwischenlagerWischen();
            await pufferWischen();
            verbindung = null;
            zustand = 'neu';
          }}
        >Entfernen</Button>
      </div>
      <div class="space-y-2">
        <input class="w-full rounded-md border bg-transparent px-3 py-1.5 text-sm" type="password" placeholder="Altes Sicherungs-Passwort" bind:value={altesPasswort} />
        <input class="w-full rounded-md border bg-transparent px-3 py-1.5 text-sm" type="password" placeholder="Neues Sicherungs-Passwort" bind:value={passwort} />
        <input class="w-full rounded-md border bg-transparent px-3 py-1.5 text-sm" type="password" placeholder="Neues Passwort wiederholen" bind:value={passwort2} />
        <Button onclick={passwortÄndern} variant="secondary" size="sm" disabled={laeuft}>Passwort ändern</Button>
      </div>
      <p class="text-xs text-muted-foreground">
        Entfernen lässt das Archiv im Drive liegen — mit dem Passwort ist es später wieder lesbar.
      </p>
      <SicherungWiederherstellen aufFertig={() => {}} />
    {/if}

    {#if meldung}<p class="text-sm text-muted-foreground">{meldung}</p>{/if}
    {#if fehler}<p class="text-sm text-destructive">{fehler}</p>{/if}
</div>
