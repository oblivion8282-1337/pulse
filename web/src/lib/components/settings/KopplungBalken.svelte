<script lang="ts">
  /**
   * Die Fortschrittsanzeige des Verlaufsumzugs — beide Seiten benutzen sie
   * (Etappe F, E2E-DM).
   *
   * Sie rechnet nichts selbst: `fortschritt` aus `kopplung/umzugPlan.ts` ist
   * importfrei und geprüft, unter anderem für den Fall, den eine Komponente
   * gern übersieht — ein Konto ohne jeden lokalen Verlauf hat null Stücke,
   * und `0/0` ist keine Zahl. Ein hier inline gerechnetes `erledigt / gesamt`
   * zeigte dort `NaN %` und einen ewig laufenden Balken.
   */
  import { m } from '$lib/paraglide/messages.js';
  import { fortschritt } from '$lib/kopplung/umzugPlan';

  let { erledigt, gesamt }: { erledigt: number; gesamt: number } = $props();

  const stand = $derived(fortschritt(erledigt, gesamt));
</script>

<div class="space-y-1">
  <div
    class="h-2 w-full overflow-hidden rounded-full bg-muted"
    role="progressbar"
    aria-valuenow={stand.erledigt}
    aria-valuemin={0}
    aria-valuemax={stand.gesamt}
  >
    <div class="h-full bg-primary transition-all" style="width: {stand.anteil * 100}%"></div>
  </div>
  <p class="text-sm text-muted-foreground">
    {m.kopplung_fortschritt({ erledigt: stand.erledigt, gesamt: stand.gesamt })}
  </p>
</div>
