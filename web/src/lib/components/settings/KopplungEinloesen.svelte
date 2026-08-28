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
    umzugStand,
    verlaufUebernehmen
  } from '$lib/kopplung/empfangen';
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
    const stand = await umzugStand(kopplungId);
    bereit = stand.gesamt !== null;
    gesamt = stand.gesamt ?? 0;
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
</div>
