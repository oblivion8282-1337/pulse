<script lang="ts">
  /**
   * Kanalordner verbinden — das fehlende Gegenstück zu
   * `CommunityDateiablage.svelte` für EINEN Ablage-Kanal (`channel.ablage`).
   * Serverseitig wartet `PUT /channels/{id}/ablage/laufwerk`
   * (`routes/ablage_kanal.py`).
   *
   * **Zwei getrennte Wege, je nachdem, was dieses Gerät schon hat:**
   *
   * 1. **Konto-Laufwerk (Archiv, seit Aufgabe 9).** Trägt dieses Gerät
   *    bereits eine Nextcloud-Verbindung mit `istArchiv === true`
   *    (`SpeicherSektion.svelte`), braucht der Kanal keinen eigenen
   *    Freigabe-Link mehr — er bekommt stattdessen einen Ordner IM Archiv
   *    (`PUT /channels/{id}/ablage/ordner`, `ordnerAnlegen`). **Die
   *    Markierung „verbunden" liegt hier beim SERVER, nicht lokal** — anders
   *    als beim Weg unten gibt es kein `fuerKanal`-Feld, das ein Gerät als
   *    Besitzer auszeichnet (mehrere Ordner-Kanäle können im selben Archiv
   *    liegen, ein Einzelfeld je Verbindung würde da kollidieren). Der
   *    Status kommt deshalb aus `ordnerListe` (200 = Ordner existiert bereits
   *    → verbunden), nicht aus `verbindungFürKanal`.
   *
   * 2. **Direkter Freigabe-Link (älterer Weg, ohne Archiv).** Ohne
   *    Konto-Laufwerk bleibt der alte Ablauf: ein eigener Nextcloud-Link
   *    genau für diesen Kanal.
   *
   *    **Wer verbinden darf, entscheidet der Server, nicht diese
   *    Komponente.** Anders als beim Community-Laufwerk (dort bestimmt der
   *    Guild-Besitzer schon vorher, wer die Aufforderung überhaupt sieht)
   *    legt beim Kanal erst das ERSTE erfolgreiche `PUT` den Ersteller fest
   *    (Design §4.0, `ablage_laufwerk.py`-Docstring: `ersteller_id` = wer
   *    die Zeile zuerst anlegt). Jedes Mitglied darf es deshalb versuchen;
   *    ein 403 („schon ein anderes Konto") ist kein Programmfehler, sondern
   *    die erwartete Antwort, wenn ein anderes Mitglied schneller war.
   *
   *    **Ob DIESES Gerät der Besitzer ist**, steht lokal in
   *    `AblageVerbindung.fuerKanal` (`verbindungen.svelte.ts`) — dieselbe
   *    Regel, nach der `festigung.ts` das für Communities entscheidet, hier
   *    je Kanal. Erst nach einem erfolgreichen `PUT` UND dem Sichern des
   *    Schlüssels (`kanalLaufwerkSchluesselSichern`) trägt dieses Gerät die
   *    Markierung.
   *
   *    Startet nach erfolgreichem Verbinden sofort die Festigungsschleife
   *    (`kanalFestigung.ts`) — ohne sie bliebe der Kanal für immer bei
   *    „gerade verbunden, noch nichts gesichert" stehen. Der Konto-Laufwerk-
   *    Weg oben braucht sie NICHT: der Archiv-Hauptschlüssel liegt schon
   *    gesichert, bevor überhaupt ein Ordner-Kanal entsteht.
   */
  import { onDestroy } from 'svelte';
  import { ApiError } from '$lib/api/client';
  import { ablageKanalLaufwerkSetzen } from '$lib/api/ablageKanal.ts';
  import { ordnerAnlegen, ordnerListe } from '$lib/api/ablageKanalOrdner.ts';
  import { ablageVerbindungen } from '$lib/ablage/verbindungen.svelte.ts';
  import { kanalLaufwerkSchluesselSichern } from '$lib/ablage/kanalLaufwerkSchluessel.ts';
  import { starteKanalFestigungsSchleife } from '$lib/ablage/kanalFestigung.ts';
  import { Button } from '$lib/components/ui/button/index.js';
  import AblageLaufwerkAufforderung from './AblageLaufwerkAufforderung.svelte';
  import type { AblageVerbindung } from '$lib/ablage/verbindungen.svelte.ts';
  import { m } from '$lib/paraglide/messages.js';

  let { kanalId }: { kanalId: string } = $props();

  let status: 'laedt' | 'nicht_verbunden' | 'verbunden' = $state('laedt');
  let stoppeFestigung: (() => void) | null = null;
  let ordnerLaeuft = $state(false);
  let ordnerFehler = $state('');

  // Nextcloud-Konto-Laufwerk dieses Geräts, falls verbunden — treibt, welcher
  // der beiden Wege (Modulkopf) angezeigt wird. `$derived`, nicht einmalig
  // gelesen: `ablageVerbindungen.verbindungen` füllt sich erst nach `laden()`
  // in `pruefeStatus`, und die Karte soll umspringen, sobald das passiert
  // ist, ohne einen zweiten Auslöser zu brauchen.
  let archivVerbindung = $derived(
    ablageVerbindungen.verbindungen.find((v) => v.anbieter === 'nextcloud' && v.istArchiv === true) ??
      null
  );

  async function pruefeStatus(): Promise<void> {
    if (!ablageVerbindungen.geladen) await ablageVerbindungen.laden();
    const lokal = ablageVerbindungen.verbindungFürKanal(kanalId);
    if (lokal) {
      status = 'verbunden';
      if (!stoppeFestigung) stoppeFestigung = starteKanalFestigungsSchleife(kanalId);
      return;
    }
    // Kein lokaler Besitzer-Eintrag — das ist beim Konto-Laufwerk-Weg NIE
    // zu erwarten (Modulkopf), heisst hier also nicht zwingend
    // „nicht verbunden": den Server fragen, ob er für diesen Kanal schon
    // einen Ordner führt (`ordnerListe` wirft `ApiError(404)`, wenn nicht).
    try {
      await ordnerListe(kanalId, null, 1);
      status = 'verbunden';
      return;
    } catch (e) {
      // 404 (`ApiError`) heisst „kein Ordner-Kanal" — jeder andere Fehler
      // (Netz/Server) ist unentschieden, nichts gelernt. Beides fällt unten
      // gleich auf "nicht verbunden" zurück; ein späterer Aufruf holt es
      // nach.
      void e;
    }
    status = 'nicht_verbunden';
  }

  void pruefeStatus();
  onDestroy(() => {
    stoppeFestigung?.();
  });

  /** Legt den Ordner-Kanal im bereits verbundenen Konto-Laufwerk an — der
   *  Weg 1 aus dem Modulkopf. Kein `kanalLaufwerkSchluesselSichern` (der
   *  Archiv-Hauptschlüssel liegt schon gesichert) und keine
   *  Festigungsschleife (die gilt nur für Weg 2 unten). */
  async function imKontoLaufwerkAnlegen(): Promise<void> {
    ordnerFehler = '';
    ordnerLaeuft = true;
    try {
      await ordnerAnlegen(kanalId);
      status = 'verbunden';
    } catch (e) {
      ordnerFehler =
        e instanceof ApiError && e.status === 412
          ? m.kanal_ordner_archiv_erfordert()
          : `Verbinden fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      ordnerLaeuft = false;
    }
  }

  async function nachVerbindung(v: AblageVerbindung): Promise<string | null> {
    // Die vom Nutzer geparste WebDAV-Basis ist die Freigabe-Adresse, die der
    // Server für die Weiterreich-Route braucht (Design §4.1) — nie der rohe
    // Link selbst (der bleibt in der Verbindungs-Konfiguration).
    const basis = v.konfiguration.basis;
    if (!basis) return 'Nur ein Nextcloud-Freigabe-Link kann als Kanal-Laufwerk dienen.';
    try {
      await ablageKanalLaufwerkSetzen(kanalId, basis);
    } catch (e) {
      return e instanceof ApiError && e.status === 403
        ? 'Dieser Kanal hat bereits ein Laufwerk eines anderen Mitglieds verbunden.'
        : `Verbinden fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`;
    }
    // Erst NACH dem erfolgreichen PUT lokal als Besitzer-Gerät markieren und
    // den Schlüssel sichern — das ist die Stelle, auf die der Rest wartet:
    // erst jetzt reisen Hauptschlüssel und Freigabe-Adresse mit der nächsten
    // Sendung zu den Mitgliedern (Postfach-Verteilung, außerhalb dieser Datei).
    await ablageVerbindungen.verknüpfeMitKanal(v.id, kanalId);
    await kanalLaufwerkSchluesselSichern(kanalId, v.hauptschlüsselB64, basis);
    await pruefeStatus();
    return null;
  }
</script>

{#if status === 'laedt'}
  <!-- still: kein Flackern beim ersten Statusabruf -->
{:else if status === 'nicht_verbunden'}
  {#if archivVerbindung}
    <div
      class="rounded-lg border border-dashed p-6 text-center"
      data-testid="kanal-ablage-ordner-aufforderung"
    >
      <p class="mb-3 text-sm text-muted-foreground">
        Noch kein Ordner für diesen Kanal im Konto-Laufwerk angelegt.
      </p>
      <Button
        onclick={imKontoLaufwerkAnlegen}
        disabled={ordnerLaeuft}
        data-testid="kanal-ablage-ordner-anlegen"
      >
        {m.kanal_ordner_anlegen_knopf()}
      </Button>
    </div>
    {#if ordnerFehler}
      <p class="mt-2 text-sm text-destructive" data-testid="kanal-ablage-fehler">{ordnerFehler}</p>
    {/if}
  {:else}
    <AblageLaufwerkAufforderung
      testIdPraefix="kanal-ablage"
      hinweisText="Noch kein Laufwerk für diesen Kanal verbunden. Verbinde eines, damit der Verlauf gesichert wird."
      fehlerTestId="kanal-ablage-fehler"
      onVerbunden={nachVerbindung}
    />
  {/if}
{:else}
  <p class="text-sm text-muted-foreground" data-testid="kanal-ablage-verbunden">
    Dieses Gerät sichert diesen Kanal auf seinem Laufwerk.
  </p>
{/if}
