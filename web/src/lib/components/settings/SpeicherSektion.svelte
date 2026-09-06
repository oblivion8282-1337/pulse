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
   * WAS geprüft wird und was ein Fehler dabei bedeutet, steht seit dem
   * 2026-09-01 in `ablage/speicherPruefung.ts` — hier bleibt nur, WANN.
   */
  import { onMount, onDestroy } from 'svelte';
  import PlusIcon from '@lucide/svelte/icons/plus';
  import { Button } from '$lib/components/ui/button/index.js';
  import { ablageVerbindungen, type AblageVerbindung } from '$lib/ablage/verbindungen.svelte.ts';
  import { leereRohwerte, pruefeZustand } from '$lib/ablage/speicherPruefung.ts';
  import { archivZiel } from '$lib/ablage/archivZiel.ts';
  import {
    gleicheArchivAdresseAb,
    type ArchivAbgleich,
  } from '$lib/ablage/archivServerAbgleich.ts';
  import type { VerbindungsRohwerte } from '$lib/ablage/zustand.ts';
  import AblageVerbindenDialog from '$lib/components/ablage/AblageVerbindenDialog.svelte';
  import SpeicherVerbindungZeile from './SpeicherVerbindungZeile.svelte';
  import WiederherstellungBlock from './WiederherstellungBlock.svelte';
  import ExportBlock from './ExportBlock.svelte';
  import { m } from '$lib/paraglide/messages.js';

  const AKTUALISIERUNGS_INTERVALL_MS = 5 * 60 * 1000;

  let dialogOffen = $state(false);
  let rohwerteNachId = $state<Record<string, VerbindungsRohwerte>>({});
  let intervallId: ReturnType<typeof setInterval> | null = null;

  /** Die Rohwerte für eine Zeile: persistierter Stand, überschrieben vom letzten Live-Check. */
  function rohwerteFuer(v: AblageVerbindung): VerbindungsRohwerte {
    const basis = leereRohwerte();
    basis.anmeldungAbgelaufen = v.anmeldungAbgelaufen ?? false;
    return { ...basis, ...rohwerteNachId[v.id] };
  }

  /** Ein Befund (`pruefeZustand`) ersetzt die Rohwerte dieser Zeile; `null`
   *  heisst „nichts gelernt" und lässt den bisherigen Stand stehen. */
  async function pruefeVerbindung(v: AblageVerbindung): Promise<void> {
    const befund = await pruefeZustand(v, rohwerteNachId[v.id]);
    if (befund) rohwerteNachId = { ...rohwerteNachId, [v.id]: befund };
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
  let archivGetrennt = $state(false);

  /** Zeigt den Befund an. `true` = der Server hält, was `archivZiel` verlangt. */
  function zeigeAbgleich(befund: ArchivAbgleich): boolean {
    if (befund.art !== 'fehler') {
      archivFehler = befund.art === 'ohne-adresse' ? m.speicher_archiv_ohne_adresse() : '';
      return true;
    }
    const vorlage =
      befund.ziel === 'setzen' ? m.speicher_archiv_setzen_fehler : m.speicher_archiv_trennen_fehler;
    archivFehler = vorlage({ fehler: befund.meldung });
    return false;
  }

  async function trennen(id: string): Promise<void> {
    // **Erst beim Server abmelden, dann lokal wegräumen** — und bei einem
    // Fehlschlag gar nichts. Andersherum wäre die Verbindung aus der Liste
    // verschwunden, während der Server die Adresse behält: es gäbe danach
    // keine Oberfläche mehr, die sie loswerden könnte, und die
    // Bereitschafts-Auskunft meldete das Konto weiter als anhang-bereit —
    // womit dieser eine Nutzer das Anhängen für alle seine Gesprächspartner
    // kaputt macht (die Verteilung ist Alles-oder-nichts). Ein
    // stehengebliebener Eintrag mit sichtbarer Meldung ist dagegen ein
    // Zustand, aus dem ein zweiter Klick herausführt.
    const warArchiv = ablageVerbindungen.verbindung(id)?.istArchiv === true;
    if (warArchiv) {
      const befund = await gleicheArchivAdresseAb({ art: 'entfernen', grund: 'keins' });
      if (!zeigeAbgleich(befund)) return;
    }

    await ablageVerbindungen.entfernen(id);
    const { [id]: _entfernt, ...rest } = rohwerteNachId;
    rohwerteNachId = rest;
    archivGetrennt = warArchiv;
  }

  async function archivWechseln(id: string): Promise<void> {
    await ablageVerbindungen.setzeArchivMarkierung(id);

    // **Die Adresse muss zum Server, sonst schreibt das Archiv nie.** Ein
    // Cloud-Laufwerk ist aus dem Browser nicht beschreibbar (CORS, an einer
    // echten Nextcloud gemessen) — der Schreibweg läuft deshalb über
    // `/ablage/archiv/*`, und diese Routen brauchen die hinterlegte
    // Freigabe-Adresse. Fällt die Markierung weg oder wandert sie auf einen
    // lokalen Ordner, muss die Adresse beim Server WEG statt einfach nur
    // ungenutzt stehenzubleiben — sonst zeigt sie auf ein Laufwerk, das
    // gar nicht mehr das Archiv ist (`archivZiel.ts`).
    //
    // Ein Fehlschlag hier bleibt eine Zeile in der Oberfläche und nimmt die
    // lokale Markierung NICHT zurück: der Sync-Ordner-Fall funktioniert auch
    // ohne, und ein halb zurückgedrehter Zustand wäre schwerer zu verstehen
    // als eine Meldung.
    //
    // Der Hinweis „dein Archiv bleibt stehen" gilt hier genauso: wer die
    // Markierung abnimmt oder sie auf einen lokalen Ordner schiebt, hört
    // auf, seine Cloud zu beliefern — dieselbe Folge wie beim Trennen.
    const ziel = archivZiel(ablageVerbindungen.verbindungen);
    const gelungen = zeigeAbgleich(await gleicheArchivAdresseAb(ziel));
    if (gelungen) archivGetrennt = ziel.art === 'entfernen';
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
    {#if archivGetrennt && !archivFehler}
      <!-- Ehrlich statt beruhigend: Pulse kann in der fremden Cloud nichts
           löschen (es gibt dafür keine Route, s. `archivAdapter.ts`), und
           ohne Archiv sind Anhänge im Gespräch nicht mehr möglich — beides
           erfährt der Nutzer hier, nicht erst am fehlenden Knopf. -->
      <p class="mt-2 text-sm text-muted-foreground" data-testid="archiv-getrennt-hinweis">
        {m.speicher_archiv_getrennt_hinweis()}
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
