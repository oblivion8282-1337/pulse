<script lang="ts">
  /**
   * Kanalordner verbinden — das fehlende Gegenstück zu
   * `CommunityDateiablage.svelte` für EINEN Ablage-Kanal (`channel.ablage`).
   * Serverseitig wartet `PUT /channels/{id}/ablage/laufwerk`
   * (`routes/ablage_kanal.py`).
   *
   * **Wer verbinden darf, entscheidet der Server, nicht diese Komponente.**
   * Anders als beim Community-Laufwerk (dort bestimmt der Guild-Besitzer
   * schon vorher, wer die Aufforderung überhaupt sieht) legt beim Kanal erst
   * das ERSTE erfolgreiche `PUT` den Ersteller fest (Design §4.0,
   * `ablage_laufwerk.py`-Docstring: `ersteller_id` = wer die Zeile zuerst
   * anlegt). Jedes Mitglied darf es deshalb versuchen; ein 403 („schon ein
   * anderes Konto") ist kein Programmfehler, sondern die erwartete Antwort,
   * wenn ein anderes Mitglied schneller war.
   *
   * **Ob DIESES Gerät der Besitzer ist**, steht lokal in
   * `AblageVerbindung.fuerKanal` (`verbindungen.svelte.ts`) — dieselbe Regel,
   * nach der `festigung.ts` das für Communities entscheidet, hier je Kanal.
   * Erst nach einem erfolgreichen `PUT` UND dem Sichern des Schlüssels
   * (`kanalLaufwerkSchluesselSichern`) trägt dieses Gerät die Markierung.
   *
   * Startet nach erfolgreichem Verbinden sofort die Festigungsschleife
   * (`kanalFestigung.ts`) — ohne sie bliebe der Kanal für immer bei „gerade
   * verbunden, noch nichts gesichert" stehen.
   */
  import { onDestroy } from 'svelte';
  import { ApiError } from '$lib/api/client';
  import { ablageKanalLaufwerkSetzen } from '$lib/api/ablageKanal.ts';
  import { ordnerAnlegen } from '$lib/api/ablageKanalOrdner.ts';
  import { ablageVerbindungen } from '$lib/ablage/verbindungen.svelte.ts';
  import { kanalLaufwerkSchluesselSichern } from '$lib/ablage/kanalLaufwerkSchluessel.ts';
  import { starteKanalFestigungsSchleife } from '$lib/ablage/kanalFestigung.ts';
  import AblageLaufwerkAufforderung from './AblageLaufwerkAufforderung.svelte';
  import type { AblageVerbindung } from '$lib/ablage/verbindungen.svelte.ts';
  import { m } from '$lib/paraglide/messages.js';

  let { kanalId }: { kanalId: string } = $props();

  let status: 'laedt' | 'nicht_verbunden' | 'verbunden' = $state('laedt');
  let stoppeFestigung: (() => void) | null = null;

  async function pruefeStatus(): Promise<void> {
    if (!ablageVerbindungen.geladen) await ablageVerbindungen.laden();
    const lokal = ablageVerbindungen.verbindungFürKanal(kanalId);
    status = lokal ? 'verbunden' : 'nicht_verbunden';
    if (lokal && !stoppeFestigung) {
      stoppeFestigung = starteKanalFestigungsSchleife(kanalId);
    }
  }

  void pruefeStatus();
  onDestroy(() => {
    stoppeFestigung?.();
  });

  async function nachVerbindung(v: AblageVerbindung): Promise<string | null> {
    // Nextcloud-Konto-Laufwerk (Archiv, `SpeicherSektion`): der Kanal bekommt
    // hier keinen eigenen Freigabe-Link, sondern einen Ordner IM Archiv —
    // der Server legt ihn per PUT an (`ordnerAnlegen`, 412 ohne Archiv). Kein
    // `kanalLaufwerkSchluesselSichern` (der Archiv-Hauptschluessel liegt
    // schon gesichert) und keine Festigungsschleife (die gilt nur fuer den
    // aelteren Direkt-Laufwerk-Weg unten).
    if (v.anbieter === 'nextcloud' && v.istArchiv === true) {
      try {
        await ordnerAnlegen(kanalId);
      } catch (e) {
        return e instanceof ApiError && e.status === 412
          ? m.kanal_ordner_archiv_erfordert()
          : `Verbinden fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`;
      }
      status = 'verbunden';
      return null;
    }
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
  <AblageLaufwerkAufforderung
    testIdPraefix="kanal-ablage"
    hinweisText="Noch kein Laufwerk für diesen Kanal verbunden. Verbinde eines, damit der Verlauf gesichert wird."
    fehlerTestId="kanal-ablage-fehler"
    onVerbunden={nachVerbindung}
  />
{:else}
  <p class="text-sm text-muted-foreground" data-testid="kanal-ablage-verbunden">
    Dieses Gerät sichert diesen Kanal auf seinem Laufwerk.
  </p>
{/if}
