/**
 * Rettungsweg gegen den GPU-Reset auf AMD unter Linux: stirbt der Player mit
 * `abort()`, läuft der nächste Versuch ohne Hardware-Dekodierung.
 *
 * **Ursache, Messungen und wen es trifft stehen NICHT hier**, sondern an der
 * einen maßgeblichen Stelle: `streaming/pulse-player/src/decode.rs` bei
 * `hwdec_vorgabe`. Dieser Text musste dort schon einmal korrigiert werden
 * (2026-08-04, die Annahme „trifft kaum jemanden" war falsch) — eine zweite
 * Fassung hier hieße, dass die nächste Korrektur eine davon vergisst und als
 * glaubwürdig aussehende Falschaussage stehen lässt.
 *
 * **Warum der Rettungsweg hier liegt und nicht im Player.** Der Coredump zeigt
 * `abort()` in `amdgpu_ctx_set_sw_reset_status` auf Mesas eigenem Submit-Thread
 * (`util_queue_thread_func`): kein Rückgabewert, kein Panic, nichts, was der
 * Player-Prozess selbst sehen könnte. Wer den Sturz auffangen will, muss ihn
 * von aussen sehen — also hier, am `exit` des Kindprozesses.
 *
 * **Warum der Rückfall trotz Kosten richtig ist.** Software-Dekodierung kostet
 * Rechenzeit, aber ein langsameres Bild ist das bessere Ende als gar keines:
 * sonst ist das Fenster weg und die Kachel fällt auf Chromiums `<video>`
 * zurück, das auf Wayland immer 8 bit ausgibt.
 *
 * **Nur für diesen App-Lauf, bewusst.** Es wäre naheliegend, den Rückfall in
 * `store.ts` zu merken und die Hardware dauerhaft auszulassen. Genau das wäre
 * falsch: der Sturz hängt an der LAST (verlorene Bündel, geteilte Video-Einheit
 * bei gleichzeitigem Senden), nicht am Gerät. Ein einziger schlechter
 * Netz-Moment würde dem Rechner sonst für immer die Hardware-Dekodierung
 * nehmen, ohne dass es je jemand bemerkt oder zurücknimmt.
 *
 * Bewusst ohne `electron`-Import und ohne Uhr — damit als reine Funktion
 * prüfbar, wie die Absturz-Erkennung des Capture-Sidecars nebenan.
 */

/**
 * Beendigungscode einer über `abort()` gestorbenen Anwendung, wie ihn eine
 * Shell meldet (128 + SIGABRT). Node liefert normalerweise `signal: 'SIGABRT'`
 * und `code: null`; die Zahl deckt die Fälle ab, in denen der Prozess über
 * einen Zwischenwirt (Flatpak-Wrapper, `sh -c`) gestartet wurde und nur noch
 * dessen Beendigungscode ankommt.
 */
const ABORT_EXIT_CODE = 134;

/**
 * Ist dieser Prozess über `abort()` gestorben?
 *
 * Absichtlich NICHT auf Linux eingeschränkt, obwohl der belegte Fall dort
 * liegt: eine Plattformabfrage würde einen unbekannten Sturz anderswo
 * ungebremst durchlaufen lassen, und der Rückfall auf Software-Dekodierung ist
 * überall der harmlose Ausgang. Andere Beendigungsarten bleiben aussen vor —
 * ein sauberes Ende, SIGTERM beim Herunterfahren oder ein Startfehler haben
 * mit der Dekodierung nichts zu tun.
 */
export function istAbbruch(code: number | null, signal: string | null): boolean {
  return signal === 'SIGABRT' || code === ABORT_EXIT_CODE;
}

/**
 * Der Wächter merkt sich genau ein Bit: ob schon zurückgefallen wurde.
 *
 * Ein Zähler wäre hier eine Scheingenauigkeit — nach dem ersten Rückfall gibt
 * es nichts mehr abzuschalten, und ein zweiter Sturz mit Software-Dekodierung
 * hat eine andere Ursache und gehört nicht hierher gebogen. Wiederholtes
 * Aufmachen und Sterben begrenzt der Renderer bereits (`ERSATZ_MAX` in
 * `web/src/lib/player/store.svelte.ts`).
 */
export function createHwdecWacht() {
  let abgeschaltet = false;
  return {
    /**
     * Einen beendeten Player melden. Liefert `true`, wenn DIESER Sturz die
     * Hardware-Dekodierung gerade abgeschaltet hat — nur dann ist eine Meldung
     * ins Log fällig, und nur dann darf der Renderer einen zweiten Versuch
     * wagen.
     */
    absturzGemeldet(code: number | null, signal: string | null): boolean {
      if (abgeschaltet || !istAbbruch(code, signal)) return false;
      abgeschaltet = true;
      return true;
    },
    /** Läuft der nächste Start ohne Hardware-Dekodierung? */
    hardwareAbgeschaltet(): boolean {
      return abgeschaltet;
    },
  };
}
