<script lang="ts">
  /**
   * Die Seite des NEUEN Geräts: Code eintippen, einlösen, Verlauf übernehmen
   * (Etappe F, E2E-DM).
   *
   * **Der Anhang-Hinweis steht hier fest, nicht als Bedingung.** Anhang-Bytes
   * ziehen grundsätzlich nicht mit (Begründung im Kopf von
   * `routes/kopplung_umzug.py`) — das ist keine Ausnahme, die manchmal
   * eintritt, sondern die Regel. Ihn nur bei Bedarf zu zeigen hiesse, sich auf
   * eine Zählung zu verlassen, die der Empfänger gar nicht hat: er sieht die
   * Anhang-ANGABEN, nicht die fehlenden Bytes.
   *
   * **Warum das Übernehmen ein eigener Knopf ist und nicht automatisch
   * anläuft:** der Sender braucht bis zur Freigabe eine unbestimmte Zeit. Ein
   * automatischer Lauf, der auf `gesamt === null` trifft, müsste entweder
   * pollen (ein zweiter Takt neben dem der Gegenseite) oder scheitern. Ein
   * Knopf, der erst erscheint, wenn wirklich etwas da ist, sagt dasselbe ohne
   * beides.
   */
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import KopplungBalken from './KopplungBalken.svelte';
  import { m } from '$lib/paraglide/messages.js';
  import {
    EinloesenFehlgeschlagen,
    kopplungEinloesen,
    kopplungVerwerfen,
    umzugStand,
    verlaufUebernehmen
  } from '$lib/kopplung/empfangen';
  import { standSicherAbfragen } from '$lib/kopplung/standAbfragen';
  import { kannVerwerfen } from '$lib/kopplung/ansichtZustand';
  import type { EinloesFehler } from '$lib/kopplung/einloesFehler';

  let eingabe = $state('');
  let laeuft = $state(false);
  let kopplungId = $state<string | null>(null);
  let code = $state<string | null>(null);
  let bereit = $state(false);
  let geholt = $state(0);
  let gesamt = $state(0);
  let uebernommen = $state<number | null>(null);
  let fehler = $state<EinloesFehler | null>(null);

  /** Solange eine Kopplung laeuft und noch nichts uebernommen ist, gibt es
   *  einen Weg zurueck (Befund 3, Bughunt 2026-08-29) — sonst haengt der
   *  Empfaenger auf einer toten Kennung fest, wenn der Sender abbricht. */
  const darfVerwerfen = $derived(kannVerwerfen(kopplungId, uebernommen));

  /** Die Fehlergründe stehen als eigene Nachrichten im Katalog — kein
   *  zusammengesetzter Schlüssel, damit ein fehlender Text beim Übersetzen
   *  auffällt statt zur Laufzeit zu verschwinden. */
  function fehlertext(grund: EinloesFehler): string {
    switch (grund) {
      case 'code_ungueltig':
        return m.kopplung_fehler_code_ungueltig();
      case 'kopplung_unbekannt':
        return m.kopplung_fehler_kopplung_unbekannt();
      case 'kopplung_schon_eingeloest':
        return m.kopplung_fehler_kopplung_schon_eingeloest();
      case 'kopplung_abgelaufen':
        return m.kopplung_fehler_kopplung_abgelaufen();
      case 'kopplung_selbes_geraet':
        return m.kopplung_fehler_kopplung_selbes_geraet();
      default:
        return m.kopplung_fehler_unbekannt();
    }
  }

  async function einloesen() {
    fehler = null;
    laeuft = true;
    try {
      const ergebnis = await kopplungEinloesen(eingabe);
      kopplungId = ergebnis.kopplungId;
      code = ergebnis.code;
      await standPruefen();
    } catch (err) {
      fehler = err instanceof EinloesenFehlgeschlagen ? err.grund : 'unbekannt';
    } finally {
      laeuft = false;
    }
  }

  async function standPruefen() {
    if (kopplungId === null) return;
    // Befund 2 (Bughunt 2026-08-29): diese Funktion war die einzige der drei
    // hier ohne Fehlerbehandlung. Ist die Kopplung weg (Sender hat
    // abgebrochen, Frist abgelaufen), wirft der Aufruf ungefangen — der
    // Knopf sah aus, als taete er nichts. `standSicherAbfragen` faengt den
    // Wurf und ordnet ihn demselben Fehler-Vokabular zu wie `einloesen()`.
    const ergebnis = await standSicherAbfragen(() => umzugStand(kopplungId!));
    if (!ergebnis.ok) {
      fehler = ergebnis.fehler;
      return;
    }
    fehler = null;
    bereit = ergebnis.bereit;
    gesamt = ergebnis.gesamt;
  }

  /** Befund 3 (Bughunt 2026-08-29): ein Weg zurueck, wenn der Sender vor der
   *  Uebernahme abbricht — sonst bleibt nur ein Neuladen der Seite. */
  async function verwerfen() {
    const id = kopplungId;
    kopplungId = null;
    code = null;
    bereit = false;
    geholt = 0;
    gesamt = 0;
    fehler = null;
    if (id !== null) {
      try {
        await kopplungVerwerfen(id);
      } catch {
        // Bleibt sie stehen, raeumt sie die Frist weg (`kopplung_pflege.py`).
      }
    }
  }

  async function uebernehmen() {
    if (kopplungId === null || code === null) return;
    laeuft = true;
    try {
      const ergebnis = await verlaufUebernehmen(kopplungId, code, (g, ges) => {
        geholt = g;
        gesamt = ges;
      });
      uebernommen = ergebnis.saetze;
    } catch {
      fehler = 'unbekannt';
    } finally {
      laeuft = false;
    }
  }
</script>

<div class="space-y-3">
  <p class="text-sm text-muted-foreground">{m.kopplung_eingeben_hinweis()}</p>

  {#if kopplungId === null}
    <Input
      bind:value={eingabe}
      placeholder={m.kopplung_eingeben_platzhalter()}
      autocapitalize="characters"
      autocomplete="off"
      spellcheck={false}
      class="font-mono tracking-widest"
      data-testid="kopplung-eingabe"
    />
    <Button onclick={einloesen} disabled={laeuft} data-testid="kopplung-einloesen">
      {m.kopplung_eingeben_knopf()}
    </Button>
  {:else if uebernommen !== null}
    <p class="text-sm" data-testid="kopplung-uebernommen">
      {m.kopplung_uebernommen({ saetze: uebernommen })}
    </p>
    <p class="text-sm text-muted-foreground">{m.kopplung_anhaenge_hinweis()}</p>
  {:else if bereit}
    <div data-testid="kopplung-empfang-fortschritt">
      <KopplungBalken erledigt={geholt} {gesamt} />
    </div>
    <Button onclick={uebernehmen} disabled={laeuft} data-testid="kopplung-uebernehmen">
      {m.kopplung_eingeben_uebernehmen()}
    </Button>
    <p class="text-sm text-muted-foreground">{m.kopplung_anhaenge_hinweis()}</p>
  {:else}
    <p class="text-sm text-muted-foreground">{m.kopplung_eingeben_wartet()}</p>
    <Button variant="outline" onclick={standPruefen} data-testid="kopplung-stand-pruefen">
      {m.kopplung_eingeben_uebernehmen()}
    </Button>
  {/if}

  {#if fehler !== null}
    <p class="text-sm text-destructive" data-testid="kopplung-fehler">{fehlertext(fehler)}</p>
  {/if}

  {#if darfVerwerfen}
    <Button variant="outline" onclick={verwerfen} data-testid="kopplung-verwerfen">
      {m.kopplung_eingeben_abbrechen()}
    </Button>
  {/if}
</div>
