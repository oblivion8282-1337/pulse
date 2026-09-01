<script lang="ts">
  /**
   * Speicher — Einstellungs-Reiter: Laufwerke verbinden, ihren Zustand
   * sehen, den Ordner wählen (Entwurf §6.1, Plan Aufgabe 5). Ersetzt den
   * Prototyp `AblageSektion.svelte`.
   *
   * **Zwei Entscheidungen, hier begründet:**
   *
   * 1. **Aktualisierungs-Rhythmus.** Ein Dauerpoller in einer nicht offenen
   *    Einstellungsseite wäre Verschwendung, ein reiner Beim-Öffnen-Messen
   *    zeigt veraltete Werte, sobald die Seite länger offen bleibt (z. B.
   *    während eine Anmeldung im Hintergrund abläuft). Deshalb: einmal
   *    sofort beim Mount, danach alle 5 Minuten — **nur solange die
   *    Komponente gemountet ist** (`onMount`/`onDestroy`, kein
   *    modul-globaler Timer). 5 Minuten, weil der einzige Zweck der
   *    Prüfung „Anmeldung abgelaufen" rechtzeitig zu bemerken ist, nicht
   *    Sekundengenauigkeit — der Entwurf nennt das den häufigsten
   *    Dauerfehler, nicht einen zeitkritischen.
   * 2. **Kontingent.** Kein einziger der drei Adapter mit Auffrisch-Weg
   *    (Dropbox, Google Drive, Nextcloud/WebDAV) ruft heute eine
   *    Kontingent-Abfrage ab — nachgesehen im jeweiligen Quelltext, nicht
   *    aus der Anbieter-Dokumentation gefolgert (Entwurf §11 Punkt 4).
   *    `VerbindungsRohwerte.freieBytes` bleibt deshalb überall `null`, und
   *    `SpeicherVerbindungZeile` zeigt dann konsequent keine Zahl — eine
   *    leere Zahl wäre schlimmer als keine.
   *
   * Die periodische Prüfung deckt nur Dropbox/Google Drive/Nextcloud ab: ein
   * Sync-Ordner braucht eine Nutzer-Geste (File-System-Access) und lässt
   * sich nicht im Hintergrund ansprechen (s. `verbindungen.ts::adapterFür`);
   * S3 wird in der Oberfläche nicht angeboten (`anbieter.ts`).
   */
  import { onMount, onDestroy } from 'svelte';
  import PlusIcon from '@lucide/svelte/icons/plus';
  import { Button } from '$lib/components/ui/button/index.js';
  import {
    ablageVerbindungen,
    adapterFür,
    type AblageVerbindung,
  } from '$lib/ablage/verbindungen.svelte.ts';
  import { AnmeldungAbgelaufenFehler } from '$lib/ablage/oauth.ts';
  import { LaufwerkWegFehler } from '$lib/ablage/ordnerGriff.ts';
  import { archivEintraegeAusstehend } from '$lib/ablage/archivSchreibweg.ts';
  import { archivLaufwerkSetzen } from '$lib/api/ablageArchiv';
  import { direktErreichbar } from '$lib/ablage/archivAdapter.ts';
  import type { VerbindungsRohwerte } from '$lib/ablage/zustand.ts';
  import AblageVerbindenDialog from '$lib/components/ablage/AblageVerbindenDialog.svelte';
  import SpeicherVerbindungZeile from './SpeicherVerbindungZeile.svelte';
  import WiederherstellungBlock from './WiederherstellungBlock.svelte';
  import ExportBlock from './ExportBlock.svelte';
  import { m } from '$lib/paraglide/messages.js';

  const AKTUALISIERUNGS_INTERVALL_MS = 5 * 60 * 1000;
  /** Anbieter, die sich ohne Nutzer-Geste aus gespeicherten Werten neu
   *  ansprechen lassen.
   *
   *  `sync_ordner` steht seit dem 2026-09-01 mit dabei, obwohl ein
   *  Ordner-Zugriff eine Nutzer-Geste braucht: die BRAUCHT nur das aktive
   *  Nachfragen, nicht das Prüfen. Steht die Berechtigung noch auf
   *  „erteilt", läuft der Zugriff durch; steht sie nach einem Neuladen auf
   *  „nachfragen", meldet der Weg `LaufwerkWegFehler` — und genau das soll
   *  die Zeile zeigen, statt weiter „alles in Ordnung" zu behaupten. */
  const PRUEFBARE_ANBIETER = new Set<AblageVerbindung['anbieter']>([
    'dropbox',
    'gdrive',
    'nextcloud',
    'sync_ordner',
  ]);

  let dialogOffen = $state(false);
  let rohwerteNachId = $state<Record<string, VerbindungsRohwerte>>({});
  let intervallId: ReturnType<typeof setInterval> | null = null;

  function leereRohwerte(): VerbindungsRohwerte {
    return { anmeldungAbgelaufen: false, laufwerkWeg: false, freieBytes: null, benoetigteBytes: 0, ausstehend: 0 };
  }

  /** Die Rohwerte für eine Zeile: persistierter Stand, überschrieben vom letzten Live-Check. */
  function rohwerteFuer(v: AblageVerbindung): VerbindungsRohwerte {
    const basis = leereRohwerte();
    basis.anmeldungAbgelaufen = v.anmeldungAbgelaufen ?? false;
    // Was noch aussteht, weiss nur die Archiv-Warteschlange — und nur die
    // markierte Verbindung bekommt etwas ab. Bei allen anderen bleibt die
    // Zahl bei null, statt dieselbe Zahl mehrfach zu zeigen und damit einen
    // Rückstand zu erfinden, den es nur einmal gibt.
    if (v.istArchiv) basis.ausstehend = archivEintraegeAusstehend();
    return { ...basis, ...rohwerteNachId[v.id] };
  }

  /**
   * Prüft eine Verbindung leichtgewichtig (nur `liste()`, keine Probe — die
   * Probe ist für den Verbinden-Moment, nicht für einen Dauerpoller, der
   * sonst Rechte-Anfragen wie „schreibe/lösche" gegen fremde Konten stellt,
   * ohne dass der Nutzer gerade etwas verbindet). Ein
   * `AnmeldungAbgelaufenFehler` ist die einzige Antwort, die hier als
   * Zustand gilt — jeder andere Fehler (Netz, 500) ist kein Befund über die
   * Verbindung, sondern über den Moment, und lässt den zuletzt bekannten
   * Stand stehen.
   */
  async function pruefeVerbindung(v: AblageVerbindung): Promise<void> {
    if (!PRUEFBARE_ANBIETER.has(v.anbieter)) return;
    try {
      const adapter = await adapterFür(v);
      await adapter.liste();
      rohwerteNachId = { ...rohwerteNachId, [v.id]: { ...leereRohwerte(), ...rohwerteNachId[v.id], anmeldungAbgelaufen: false } };
    } catch (fehler) {
      if (fehler instanceof AnmeldungAbgelaufenFehler) {
        await ablageVerbindungen.markiereAnmeldungAbgelaufen(v.id);
        rohwerteNachId = { ...rohwerteNachId, [v.id]: { ...leereRohwerte(), anmeldungAbgelaufen: true } };
      } else if (fehler instanceof LaufwerkWegFehler) {
        // Nicht in der Verbindung festschreiben: anders als eine abgelaufene
        // Anmeldung ist das oft nur der Zustand DIESER Sitzung — nach einem
        // Neuladen steht die Ordner-Berechtigung auf „nachfragen", und der
        // nächste Klick des Nutzers stellt sie wieder her.
        rohwerteNachId = { ...rohwerteNachId, [v.id]: { ...leereRohwerte(), laufwerkWeg: true } };
      }
    }
  }

  async function alleZustaendePruefen(): Promise<void> {
    if (!ablageVerbindungen.geladen) await ablageVerbindungen.laden();
    await Promise.all(ablageVerbindungen.verbindungen.map(pruefeVerbindung));
  }

  onMount(() => {
    void alleZustaendePruefen();
    intervallId = setInterval(() => void alleZustaendePruefen(), AKTUALISIERUNGS_INTERVALL_MS);
  });

  onDestroy(() => {
    if (intervallId !== null) clearInterval(intervallId);
  });

  function handgriff(): void {
    // Sowohl „neu anmelden" als auch „Ordner neu wählen" führen heute zum
    // selben Verbinden-Dialog: ein echtes Reconnect-in-place (dieselbe
    // Verbindungs-Id behalten) gibt es noch nicht — die OAuth-Anbindung
    // dahinter fehlt noch (s. Kopf von `AblageVerbindenDialog.svelte`).
    dialogOffen = true;
  }

  let archivFehler = $state('');

  async function trennen(id: string): Promise<void> {
    await ablageVerbindungen.entfernen(id);
    const { [id]: _entfernt, ...rest } = rohwerteNachId;
    rohwerteNachId = rest;
  }

  async function archivWechseln(id: string): Promise<void> {
    await ablageVerbindungen.setzeArchivMarkierung(id);

    // **Die Adresse muss zum Server, sonst schreibt das Archiv nie.** Ein
    // Cloud-Laufwerk ist aus dem Browser nicht beschreibbar (CORS, an einer
    // echten Nextcloud gemessen) — der Schreibweg läuft deshalb über
    // `/ablage/archiv/*`, und diese Routen brauchen die hinterlegte
    // Freigabe-Adresse. Ein lokaler Sync-Ordner braucht das nicht: dort
    // schreibt der Browser selbst, und es gibt keine Adresse, die ein
    // Server ansprechen könnte.
    //
    // Ein Fehlschlag hier bleibt eine Zeile in der Oberfläche und nimmt die
    // lokale Markierung NICHT zurück: der Sync-Ordner-Fall funktioniert auch
    // ohne, und ein halb zurückgedrehter Zustand wäre schwerer zu verstehen
    // als eine Meldung.
    const v = ablageVerbindungen.verbindung(id);
    if (!v || direktErreichbar(v.anbieter)) return;
    const adresse = v.konfiguration.basis;
    if (!adresse) {
      archivFehler = 'Dieses Laufwerk hat keine Adresse, die Pulse ansprechen kann.';
      return;
    }
    try {
      await archivLaufwerkSetzen(adresse);
      archivFehler = '';
    } catch (e) {
      archivFehler = `Das Archiv-Laufwerk konnte nicht hinterlegt werden: ${
        e instanceof Error ? e.message : String(e)
      }`;
    }
  }

  function verbunden(v: AblageVerbindung): void {
    dialogOffen = false;
    void pruefeVerbindung(v);
  }
</script>

<section class="space-y-4" data-testid="speicher-sektion">
  <div>
    <h3 class="text-base font-semibold">{m.speicher_titel()}</h3>
    <p class="text-sm text-muted-foreground">{m.speicher_beschreibung()}</p>
    {#if archivFehler}
      <!-- Sichtbar, nicht nur gesetzt: schlaegt das Hinterlegen fehl, wird
           in dieses Archiv nie etwas geschrieben — und ohne diese Zeile
           merkte es niemand, weil der Schreibweg selbst still ist. -->
      <p class="mt-2 text-sm text-destructive" data-testid="archiv-laufwerk-fehler">
        {archivFehler}
      </p>
    {/if}
  </div>

  {#if ablageVerbindungen.verbindungen.length === 0}
    <p class="text-sm text-muted-foreground">{m.speicher_leer()}</p>
  {:else}
    <div class="space-y-2">
      {#each ablageVerbindungen.verbindungen as v (v.id)}
        <SpeicherVerbindungZeile
          verbindung={v}
          rohwerte={rohwerteFuer(v)}
          onHandgriff={handgriff}
          onTrennen={() => trennen(v.id)}
          onArchivWechsel={() => archivWechseln(v.id)}
        />
      {/each}
    </div>
  {/if}

  <Button variant="secondary" size="sm" onclick={() => (dialogOffen = true)} data-testid="speicher-verbinden">
    <PlusIcon class="size-4" />
    {m.speicher_verbinden()}
  </Button>
</section>

<div class="border-border border-t pt-4">
  <WiederherstellungBlock />
</div>

<div class="border-border border-t pt-4">
  <ExportBlock />
</div>

<AblageVerbindenDialog open={dialogOffen} onClose={() => (dialogOffen = false)} onVerbunden={verbunden} />
