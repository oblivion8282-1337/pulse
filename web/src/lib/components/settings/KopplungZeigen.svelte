<script lang="ts">
  /**
   * Die Seite des EINGERICHTETEN Geräts: Code erzeugen, anzeigen, warten,
   * Verlauf schieben (Etappe F, E2E-DM).
   *
   * **Der Code steht nur hier im Speicher, nie im Netz.** `kopplungStarten`
   * schickt allein seinen Hash; der Klartext bleibt in dieser Komponente und
   * wird beim Verlassen mit ihr verworfen. Wer ihn irgendwo persistierte,
   * hebelte die kurze Frist aus, die ihn absichert.
   *
   * **Gepollt statt gepusht.** Es gibt keinen WS-Rahmen für „jemand hat
   * eingelöst" — einen einzuführen wäre eine Änderung am Verteilweg für einen
   * Vorgang, der Sekunden dauert und bei dem ein Mensch zuschaut. Der Takt
   * hört auf, sobald eingelöst ist.
   */
  import { onDestroy } from 'svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import KopplungBalken from './KopplungBalken.svelte';
  import { m } from '$lib/paraglide/messages.js';
  import { codeAnzeigen } from '$lib/kopplung/code';
  import { qrSvgFuerCode } from '$lib/kopplung/qr';
  import { istEingeloest, kopplungAbbrechen, kopplungStarten, verlaufSchieben } from '$lib/kopplung/senden';
  import { erneutVersuchenGesperrt, kannErneutSchieben } from '$lib/kopplung/ansichtZustand';

  /** Wie oft nachgefragt wird, ob das andere Gerät eingelöst hat. */
  const TAKT_MS = 2000;

  let code = $state<string | null>(null);
  let kopplungId = $state<string | null>(null);
  let laeuft = $state(false);
  let verbunden = $state(false);
  let geschoben = $state(0);
  let gesamt = $state(0);
  let fertig = $state(false);
  let fehler = $state<string | null>(null);
  let takt: ReturnType<typeof setInterval> | null = null;
  // Befund 3 (Bughunt 2026-08-29, Runde 6): eigenes Flag fuer einen
  // laufenden Schiebe-Versuch — `laeuft` deckt nur `starten()` ab, ein
  // Doppelklick auf „Erneut versuchen" traf `schieben()` bisher ungeschuetzt
  // und startete zwei parallele Laeufe (s. `ansichtZustand.ts`).
  let schiebtGerade = $state(false);

  // QR-Markup wird bei jeder Aenderung von `code` frisch erzeugt (nicht
  // gecacht) — der Code lebt ohnehin nur so lange wie diese Komponente, ein
  // Cache brächte hier keinen Vorteil, nur eine zweite Kopie im Speicher.
  const qrSvg = $derived(code === null ? null : qrSvgFuerCode(code, m.kopplung_qr_alt()));

  // Befund 1 (Bughunt 2026-08-29): `verlaufSchieben` konnte immer schon
  // fortsetzen (`senden.ts` fragt den Stand ab und schiebt nur die
  // Differenz) — erreichbar war das nur nicht, weil es keinen Knopf gab, es
  // erneut zu versuchen. Kennung und Code bleiben nach einem Fehlschlag im
  // `$state` dieser Komponente stehen (`schieben()` raeumt sie nicht weg),
  // ein erneuter Lauf trifft also auf echte Vorarbeit.
  const darfErneutSchieben = $derived(kannErneutSchieben(kopplungId, fehler, fertig));

  function taktStoppen() {
    if (takt !== null) clearInterval(takt);
    takt = null;
  }

  onDestroy(taktStoppen);

  async function starten() {
    fehler = null;
    laeuft = true;
    try {
      const neu = await kopplungStarten();
      kopplungId = neu.kopplungId;
      code = neu.code;
      takt = setInterval(pruefen, TAKT_MS);
    } catch (err) {
      fehler = String(err);
    } finally {
      laeuft = false;
    }
  }

  async function pruefen() {
    if (kopplungId === null || verbunden) return;
    try {
      if (!(await istEingeloest(kopplungId))) return;
    } catch {
      // Ein einzelner fehlgeschlagener Takt ist kein Abbruch — der nächste
      // fragt erneut. Nur ein sichtbarer Fehler hier wäre falsch: er stünde
      // neben einem Code, der weiterhin gilt.
      return;
    }
    verbunden = true;
    taktStoppen();
    await schieben();
  }

  /** Wiederholt einen fehlgeschlagenen Schiebe-Versuch mit derselben
   *  Kennung (Befund 1). Der Fehlertext wird erst hier geloescht, nicht
   *  vorzeitig — sonst verschwaende der Hinweis schon beim blossen
   *  Anzeigen des Knopfs. */
  async function erneutVersuchen() {
    fehler = null;
    await schieben();
  }

  /** Befund 3: der Schutz sitzt HIER, nicht nur am Knopf — `pruefen()` ruft
   *  `schieben()` ebenfalls auf (der erste Versuch nach dem Einloesen), und
   *  ohne den Guard an dieser Stelle koennte ein Takt-ausgeloester und ein
   *  Knopf-ausgeloester Lauf ebenso ueberlappen. */
  async function schieben() {
    if (kopplungId === null || code === null) return;
    if (erneutVersuchenGesperrt(schiebtGerade)) return;
    schiebtGerade = true;
    try {
      const ergebnis = await verlaufSchieben(kopplungId, code, (g, ges) => {
        geschoben = g;
        gesamt = ges;
      });
      gesamt = ergebnis.gesamt;
      fertig = true;
    } catch (err) {
      fehler = String(err);
    } finally {
      schiebtGerade = false;
    }
  }

  async function abbrechen() {
    taktStoppen();
    const id = kopplungId;
    code = null;
    kopplungId = null;
    verbunden = false;
    if (id !== null) {
      // Bewusst ohne `await` vor dem Zurücksetzen der Anzeige: der Code ist
      // in dem Moment ungültig, in dem er vom Bildschirm verschwindet — ob
      // der Server ihn schon gelöscht hat, ist für den Nutzer nachrangig.
      try {
        await kopplungAbbrechen(id);
      } catch {
        // Bleibt er stehen, räumt ihn die Frist weg (`kopplung_pflege.py`).
      }
    }
  }
</script>

<div class="space-y-3">
  <p class="text-sm text-muted-foreground">{m.kopplung_zeigen_hinweis()}</p>

  {#if code === null}
    <Button onclick={starten} disabled={laeuft} data-testid="kopplung-code-erzeugen">
      {m.kopplung_zeigen_starten()}
    </Button>
  {:else}
    <p
      class="select-all rounded-md border bg-muted px-4 py-3 text-center font-mono text-lg tracking-widest"
      data-testid="kopplung-code"
    >
      {codeAnzeigen(code)}
    </p>

    {#if qrSvg !== null}
      <!--
        Der Textcode oben bleibt der Pflichtweg (Spec §6, Barrierefreiheit
        + ohne Kamera nutzbar) — der QR-Code hier ist eine gleichrangig
        SICHTBARE Bequemlichkeit, nie die einzige Quelle des Codes. Das
        `{@html}` ist unbedenklich: `qrSvgFuerCode` baut das Markup selbst
        aus Zahlen (Matrixkoordinaten) und dem eigenen, uebersetzten Titel —
        keine vom Nutzer stammende Zeichenkette landet je darin.
      -->
      <div
        class="mx-auto w-40 max-w-full rounded-md border bg-white p-2"
        data-testid="kopplung-qr"
      >
        {@html qrSvg}
      </div>
    {/if}

    {#if fertig}
      <p class="text-sm" data-testid="kopplung-zeigen-fertig">
        {m.kopplung_zeigen_fertig({ gesamt })}
      </p>
    {:else if verbunden}
      <p class="text-sm">{m.kopplung_zeigen_verbunden()}</p>
      <div data-testid="kopplung-zeigen-fortschritt">
        <KopplungBalken erledigt={geschoben} {gesamt} />
      </div>
    {:else}
      <p class="text-sm text-muted-foreground">{m.kopplung_zeigen_wartet()}</p>
    {/if}

    <Button variant="outline" onclick={abbrechen} data-testid="kopplung-abbrechen">
      {m.kopplung_zeigen_abbrechen()}
    </Button>
  {/if}

  {#if fehler !== null}
    <p class="text-sm text-destructive" data-testid="kopplung-zeigen-fehler">{fehler}</p>
  {/if}

  {#if darfErneutSchieben}
    <Button
      onclick={erneutVersuchen}
      disabled={erneutVersuchenGesperrt(schiebtGerade)}
      data-testid="kopplung-zeigen-erneut-versuchen"
    >
      {m.kopplung_zeigen_erneut_versuchen()}
    </Button>
  {/if}
</div>
