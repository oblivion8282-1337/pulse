<script lang="ts">
  /**
   * Nextcloud verbinden — den Freigabe-Link einfügen, fertig.
   *
   * Eigene Komponente, weil der Verbinden-Dialog sonst über die
   * Größen-Grenze wächst (250 Zeilen für Svelte-Komponenten).
   *
   * Warum ein Link und nicht Nextclouds eigener Anmeldeweg: gemessen am
   * 2026-08-31. Der Anmeldeweg antwortet sauber, setzt aber keine einzige
   * CORS-Kopfzeile — im Browser unbrauchbar —, und ihn über den Pulse-Server
   * zu leiten hiesse, ein frisches App-Passwort durch fremde Hände zu
   * schicken. Der Link kann alles, was gebraucht wird, und der Adapter dafür
   * war schon da (Begründung und Messwerte im Kopf von
   * `lib/ablage/freigabeLink.ts`).
   */
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import { ausFreigabeLink, FreigabeLinkFehler } from '$lib/ablage/freigabeLink';
  import { webdavAdapter } from '$lib/ablage/webdav';
  import { probiere, type ProbeSchritt } from '$lib/ablage/probe';
  import { ablageVerbindungen, type AblageVerbindung } from '$lib/ablage/verbindungen.svelte';

  const SCHRITT_TEXT: Record<ProbeSchritt, string> = {
    schreiben: 'Schreiben',
    lesen: 'Lesen',
    vergleichen: 'Vergleichen',
    loeschen: 'Löschen',
  };

  let { onVerbunden }: { onVerbunden: (v: AblageVerbindung) => void } = $props();

  let link = $state('');
  let laeuft = $state(false);
  let fehler = $state('');

  async function verbinde(): Promise<void> {
    laeuft = true;
    fehler = '';
    try {
      const zugang = ausFreigabeLink(link);
      const adapter = webdavAdapter({ ...zugang, ordner: '' });

      // Erst die Probe, dann verbunden melden. Der wahrscheinlichste
      // Bedienfehler ist ein Link mit reinem LESERECHT — der besteht das
      // Schreiben nicht, und genau deshalb steht die Probe hier vorn statt
      // beim ersten echten Schreibversuch irgendwann später.
      const ergebnis = await probiere(adapter);
      if (!ergebnis.gut) {
        fehler =
          ergebnis.schritt === 'schreiben'
            ? `Der Link durfte nicht schreiben (${ergebnis.grund}). Prüfe in Nextcloud, ob die Freigabe „Bearbeiten erlauben" gesetzt hat.`
            : `Fehlgeschlagen beim Schritt „${SCHRITT_TEXT[ergebnis.schritt]}": ${ergebnis.grund}`;
        return;
      }

      const schluessel = globalThis.crypto.getRandomValues(new Uint8Array(32));
      const verbindung: AblageVerbindung = {
        id: `nextcloud-${zugang.benutzer.slice(0, 6)}`,
        anbieter: 'nextcloud',
        name: `Nextcloud · ${zugang.wirt}`,
        konfiguration: {
          basis: zugang.basis,
          ordner: '',
          benutzer: zugang.benutzer,
          passwort: zugang.passwort,
        },
        hauptschlüsselB64: btoa(String.fromCharCode(...schluessel)),
        verbundenAm: new Date().toISOString(),
      };
      await ablageVerbindungen.hinzufügen(verbindung);
      onVerbunden(verbindung);
    } catch (e) {
      // Ein Fehler des Parsers ist für den Nutzer verständlich formuliert und
      // wird durchgereicht; alles andere ist ein Netz- oder Serverproblem.
      fehler =
        e instanceof FreigabeLinkFehler
          ? e.message
          : `Die Verbindung kam nicht zustande: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      laeuft = false;
    }
  }
</script>

<div class="space-y-3">
  <p class="text-sm text-muted-foreground">
    Lege in Nextcloud eine Freigabe auf einen Ordner an, setze
    <strong>„Bearbeiten erlauben"</strong>, und füge den Link hier ein.
  </p>

  <div class="space-y-1.5">
    <Label for="nextcloud-link">Freigabe-Link</Label>
    <Input
      id="nextcloud-link"
      bind:value={link}
      placeholder="https://cloud.example/s/AbCdEf"
      autocomplete="off"
      spellcheck={false}
      data-testid="nextcloud-link"
    />
  </div>

  <p class="text-xs text-muted-foreground">
    Der Link ist ein Schlüssel: wer ihn hat, darf in diesen Ordner schreiben.
    In Nextcloud kannst du ihn jederzeit mit einem Klick zurückziehen.
  </p>

  <Button onclick={verbinde} disabled={laeuft || link.trim() === ''} data-testid="nextcloud-verbinden">
    {laeuft ? 'Wird geprüft …' : 'Verbinden'}
  </Button>

  {#if fehler}
    <p class="text-sm text-destructive" data-testid="nextcloud-fehler">{fehler}</p>
  {/if}
</div>
