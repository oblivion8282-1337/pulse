<script lang="ts">
  /**
   * Die Huelle eines Blattes von unten: Abdunkelung, Portal, Griff-Strich.
   *
   * **Warum gemeinsam.** Nach dem Mobil-Umbau gab es drei davon — das
   * Aktionsblatt einer Nachricht, der Kanal-Wechsler und die Profilkarte auf
   * dem Handy — und alle drei trugen dieselben zehn Zeilen samt derselben
   * wortgleich abgeschriebenen Begruendung fuer das Portal. Der INHALT der
   * drei ist voellig verschieden; gemeinsam ist nur der Behaelter, und genau
   * der steht jetzt hier.
   *
   * **Der Portal-Grund, der in allen drei Kopien stand:** `position: fixed`
   * bezieht sich NICHT aufs Fenster, sobald irgendein Vorfahre einen `filter`,
   * `backdrop-filter` oder `transform` hat — und `glass-panel` hat
   * `backdrop-filter`; im Chat steht die Nachricht zusaetzlich in einer
   * virtualisierten Liste. Ohne Portal landet das Blatt mitten im Inhalt
   * statt am unteren Bildschirmrand (nachgemessen: Unterkante bei 168 px
   * statt 844).
   *
   * Die Feinheiten bleiben beim Aufrufer: Eckenradius, Polsterung und die
   * Masse des Griff-Strichs unterscheiden sich zwischen den dreien, und ein
   * Baustein, der sie einebnet, aendert das Aussehen. `panelClass` und
   * `panelTestid` reichen sie durch.
   */
  import { Portal } from 'bits-ui';
  import type { Snippet } from 'svelte';

  let {
    open,
    testid,
    closeLabel,
    panelClass,
    panelTestid,
    onClose,
    children
  }: {
    open: boolean;
    /** Kennung der aussersten Flaeche (Abdunkelung + Blatt). */
    testid: string;
    /** Vorlesetext der Abdunkelung — sie IST der Schliessen-Knopf. */
    closeLabel: string;
    /** Klassen des Blattes selbst; jeder Aufrufer bringt seine eigenen mit. */
    panelClass: string;
    panelTestid?: string;
    onClose: () => void;
    children: Snippet;
  } = $props();
</script>

{#if open}
  <Portal>
    <div class="fixed inset-0 z-50 flex flex-col justify-end" data-testid={testid}>
      <button
        type="button"
        class="absolute inset-0 bg-black/50"
        aria-label={closeLabel}
        onclick={onClose}
      ></button>
      <div class={panelClass} data-testid={panelTestid}>
        {@render children()}
      </div>
    </div>
  </Portal>
{/if}
