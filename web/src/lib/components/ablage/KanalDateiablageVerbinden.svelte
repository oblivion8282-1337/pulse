<script lang="ts">
  /**
   * Kanalordner verbinden — das fehlende Gegenstück zu
   * `CommunityDateiablage.svelte` für EINEN Ablage-Kanal (`channel.ablage`).
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
   *    liegen). Der Status kommt deshalb aus `ordnerListe` (200 = Ordner
   *    existiert bereits → verbunden), nicht aus `verbindungFürKanal`.
   *
   *    **Der Hinweistext für diesen Zustand ist bewusst neutral.** „Dieses
   *    Gerät sichert…" stimmt hier für kein Gerät: es sichert der SERVER, in
   *    das Laufwerk des Erstellers, und wer diese Seite ansieht, ist meist
   *    gar nicht der Ersteller.
   *
   * 2. **Direkter Freigabe-Link (älterer Weg, ohne Archiv).** Ohne
   *    Konto-Laufwerk bleibt der alte Ablauf: ein eigener Nextcloud-Link
   *    genau für diesen Kanal. **Ob DIESES Gerät der Besitzer ist**, steht
   *    lokal in `AblageVerbindung.fuerKanal` (`verbindungen.svelte.ts`) —
   *    dieselbe Regel, nach der `festigung.ts` das für Communities
   *    entscheidet. Startet nach erfolgreichem Verbinden sofort die
   *    Festigungsschleife (`kanalFestigung.ts`); der Weg 1 braucht sie
   *    NICHT (der Archiv-Hauptschlüssel liegt schon gesichert).
   *
   * **Wer verbinden darf: `MANAGE_CHANNELS` im Kanal.** Der Server verlangt
   * es seit I11 an beiden PUT-Routen; die Oberfläche verlangte es bisher
   * nirgends und bot jedem Mitglied einen Knopf an, der mit 403 endete.
   * Geprüft wird über `channelPermissions.hasChannelPermission` — den
   * kanalskopierten Weg (Muster `HqStreamButton.svelte`), nicht über
   * `roles.hasGuildPermission`: eine Kanal-Abweichung kann das Recht hier
   * geben oder nehmen, und der Server rechnet ebenfalls kanalskopiert
   * (`check_permission(..., channel_id=…)`).
   */
  import { onDestroy } from 'svelte';
  import { ApiError } from '$lib/api/client';
  import { ablageKanalLaufwerkSetzen } from '$lib/api/ablageKanal.ts';
  import { ordnerAnlegen, ordnerListe } from '$lib/api/ablageKanalOrdner.ts';
  import { ablageVerbindungen } from '$lib/ablage/verbindungen.svelte.ts';
  import { kanalLaufwerkSchluesselSichern } from '$lib/ablage/kanalLaufwerkSchluessel.ts';
  import { starteKanalFestigungsSchleife } from '$lib/ablage/kanalFestigung.ts';
  import { channelPermissions } from '$lib/stores/channelPermissions.svelte';
  import { Perm } from '$lib/permissions/bitfield';
  import { Button } from '$lib/components/ui/button/index.js';
  import AblageLaufwerkAufforderung from './AblageLaufwerkAufforderung.svelte';
  import type { AblageVerbindung } from '$lib/ablage/verbindungen.svelte.ts';
  import { m } from '$lib/paraglide/messages.js';

  let { kanalId, guildId }: { kanalId: string; guildId: string } = $props();

  type Status = 'laedt' | 'nicht_verbunden' | 'verbunden_lokal' | 'verbunden_ordner';
  let status: Status = $state('laedt');
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

  let darfVerwalten = $derived(
    channelPermissions.hasChannelPermission(guildId, kanalId, Perm.MANAGE_CHANNELS)
  );

  async function pruefeStatus(): Promise<void> {
    // `ensure` füllt den Overwrite-Cache dieses Kanals — ohne ihn rechnet der
    // Resolver nur mit den Guild-Rechten und übersähe eine Kanal-Abweichung.
    // Fehlschlag ist kein Sonderfall: der Resolver fällt dann auf die
    // Guild-Ebene zurück, und der Server bleibt die verbindliche Instanz.
    void channelPermissions.ensure(kanalId).catch(() => undefined);
    if (!ablageVerbindungen.geladen) await ablageVerbindungen.laden();
    const lokal = ablageVerbindungen.verbindungFürKanal(kanalId);
    if (lokal) {
      status = 'verbunden_lokal';
      if (!stoppeFestigung) stoppeFestigung = starteKanalFestigungsSchleife(kanalId);
      return;
    }
    // Kein lokaler Besitzer-Eintrag — das ist beim Konto-Laufwerk-Weg NIE
    // zu erwarten (Modulkopf), heisst hier also nicht zwingend
    // „nicht verbunden": den Server fragen, ob er für diesen Kanal schon
    // einen Ordner führt (`ordnerListe` wirft `ApiError(404)`, wenn nicht).
    try {
      await ordnerListe(kanalId, null, 1);
      status = 'verbunden_ordner';
      return;
    } catch (e) {
      // 404 (`ApiError`) heisst „kein Ordner-Kanal" — jeder andere Fehler
      // (Netz/Server) ist unentschieden, nichts gelernt. Beides fällt unten
      // gleich auf "nicht verbunden" zurück. **Nachgeholt wird das erst beim
      // nächsten Einhängen dieser Komponente** (`pruefeStatus` läuft nur
      // dort, es gibt keine Wiederholung) — ein Netzfehler zeigt bis dahin
      // „nicht verbunden" für einen Kanal, der verbunden sein kann.
      void e;
    }
    status = 'nicht_verbunden';
  }

  void pruefeStatus();
  onDestroy(() => {
    stoppeFestigung?.();
  });

  /** Die Antwort der Anlegen-Route als Katalogtext. Alle drei Fälle sind
   *  erwartbar und keiner ein Programmfehler: 403 = das Recht fehlt (die
   *  Rechte können sich zwischen Anzeige und Klick geändert haben), 409 =
   *  der Kanal hängt schon an einem eigenen Freigabe-Link, 412 = dieses
   *  Konto hat noch gar kein Archiv. */
  function ordnerFehlerText(e: unknown): string {
    if (e instanceof ApiError) {
      if (e.status === 403) return m.kanal_ordner_fehler_kein_recht();
      if (e.status === 409) return m.kanal_ordner_fehler_belegt();
      if (e.status === 412) return m.kanal_ordner_archiv_erfordert();
    }
    return m.kanal_ordner_fehler_allgemein();
  }

  /** Legt den Ordner-Kanal im bereits verbundenen Konto-Laufwerk an — der
   *  Weg 1 aus dem Modulkopf. Kein `kanalLaufwerkSchluesselSichern` (der
   *  Archiv-Hauptschlüssel liegt schon gesichert) und keine
   *  Festigungsschleife (die gilt nur für Weg 2 unten). */
  async function imKontoLaufwerkAnlegen(): Promise<void> {
    ordnerFehler = '';
    ordnerLaeuft = true;
    try {
      await ordnerAnlegen(kanalId);
      status = 'verbunden_ordner';
    } catch (e) {
      ordnerFehler = ordnerFehlerText(e);
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
        : ordnerFehlerText(e);
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
{:else if status === 'verbunden_ordner'}
  <p class="text-sm text-muted-foreground" data-testid="kanal-ablage-verbunden">
    {m.kanal_ordner_verbunden_hinweis()}
  </p>
{:else if status === 'verbunden_lokal'}
  <p class="text-sm text-muted-foreground" data-testid="kanal-ablage-verbunden">
    Dieses Gerät sichert diesen Kanal auf seinem Laufwerk.
  </p>
{:else if !darfVerwalten}
  <!-- Ohne MANAGE_CHANNELS gibt es hier nichts zu tun: der Server lehnt
       beide PUTs ab. Ein Knopf, der sicher mit 403 endet, ist schlechter
       als keiner. -->
  <p class="text-sm text-muted-foreground" data-testid="kanal-ablage-kein-recht">
    {m.kanal_ordner_fehler_kein_recht()}
  </p>
{:else if archivVerbindung}
  <div
    class="rounded-lg border border-dashed p-6 text-center"
    data-testid="kanal-ablage-ordner-aufforderung"
  >
    <p class="mb-3 text-sm text-muted-foreground">{m.kanal_ordner_aufforderung_hinweis()}</p>
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
