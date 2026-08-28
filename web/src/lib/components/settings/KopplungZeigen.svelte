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
  import { istEingeloest, kopplungAbbrechen, kopplungStarten, verlaufSchieben } from '$lib/kopplung/senden';

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

  async function schieben() {
    if (kopplungId === null || code === null) return;
    try {
      const ergebnis = await verlaufSchieben(kopplungId, code, (g, ges) => {
        geschoben = g;
        gesamt = ges;
      });
      gesamt = ergebnis.gesamt;
      fertig = true;
    } catch (err) {
      fehler = String(err);
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
</div>
