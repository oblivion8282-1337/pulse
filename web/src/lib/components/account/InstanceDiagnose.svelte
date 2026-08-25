<!--
  Erreichbarkeitsprüfung eines eigenen Servers, von aussen.

  Das ist das Einzige, was ein Server über sich selbst nicht sagen kann: ob
  jemand von draussen ankommt. Die Cloud geht die ganze Kette ab und benennt
  das Glied, das fehlt — statt „nicht erreichbar", woran der Betreiber bisher
  hängenblieb.

  Die Reihenfolge der Zeilen ist die Reihenfolge der Kette. Der oberste rote
  Eintrag ist die Ursache; was darunter steht, ist meist nur die Folge —
  deshalb wird der erste Fehlschlag hervorgehoben und nicht der letzte.
-->
<script lang="ts">
  import { m } from '$lib/paraglide/messages.js';
  import { instancesApi, type DiagnoseErgebnis } from '$lib/api/instances';
  import { schrittSchluessel, befundSchluessel } from '$lib/diagnose/befunde';
  import { Button } from '$lib/components/ui/button';
  import CheckIcon from '@lucide/svelte/icons/check';
  import XIcon from '@lucide/svelte/icons/x';
  import ActivityIcon from '@lucide/svelte/icons/activity';
  import LoaderIcon from '@lucide/svelte/icons/loader-circle';

  let { instanceId }: { instanceId: string } = $props();

  let laeuft = $state(false);
  let ergebnis = $state<DiagnoseErgebnis | null>(null);
  let fehler = $state(false);

  // Der erste Fehlschlag trägt die Ursache. Alles danach hängt in aller Regel
  // an ihm — ein Zertifikatsproblem lässt jeden folgenden Schritt scheitern.
  const ersterFehler = $derived(ergebnis?.schritte.findIndex((s) => !s.ok) ?? -1);

  async function pruefen() {
    if (laeuft) return;
    laeuft = true;
    fehler = false;
    ergebnis = null;
    try {
      ergebnis = await instancesApi.diagnose(instanceId);
    } catch {
      fehler = true;
    } finally {
      laeuft = false;
    }
  }

  // Die Schlüssel kommen aus einer geprüften Liste (lib/diagnose/befunde.ts):
  // ein Test hält jeden erzeugbaren gegen beide Sprachdateien, ein unbekannter
  // fällt dort schon auf einen Sammelbegriff zurück. Der Zugriff kann hier
  // also nicht ins Leere greifen.
  const text = (schluessel: string): string =>
    (m as unknown as Record<string, () => string>)[schluessel]();
</script>

<div class="flex flex-col gap-3" data-testid="instance-diagnose-{instanceId}">
  <div class="flex flex-wrap items-center gap-2">
    <Button
      size="xs"
      variant="secondary"
      onclick={pruefen}
      disabled={laeuft}
      data-testid="instance-diagnose-btn-{instanceId}"
    >
      {#if laeuft}
        <LoaderIcon class="size-3.5 animate-spin" />
      {:else}
        <ActivityIcon class="size-3.5" />
      {/if}
      {m.diagnose_button()}
    </Button>
    <span class="text-text-muted text-xs">
      {laeuft ? m.diagnose_running() : m.diagnose_intro()}
    </span>
  </div>

  {#if fehler}
    <p class="text-destructive text-xs" data-testid="instance-diagnose-error">
      {m.diagnose_error()}
    </p>
  {:else if ergebnis}
    <div class="border-border bg-bg-input/30 flex flex-col gap-2 rounded-xl border p-3">
      <p
        class="text-xs font-medium {ergebnis.gesamt === 'ok' ? 'text-success' : 'text-text-bright'}"
        data-testid="instance-diagnose-summary"
      >
        {ergebnis.gesamt === 'ok' ? m.diagnose_all_ok() : m.diagnose_first_problem()}
      </p>

      <ul class="flex flex-col gap-1.5">
        {#each ergebnis.schritte as schritt, i (schritt.schritt + i)}
          {@const erklaerung = befundSchluessel(schritt.schritt, schritt.befund, schritt.ok)}
          <li class="flex items-start gap-2 text-xs">
            {#if schritt.ok}
              <CheckIcon class="text-success mt-0.5 size-3.5 shrink-0" />
            {:else}
              <XIcon class="text-destructive mt-0.5 size-3.5 shrink-0" />
            {/if}
            <div class="flex min-w-0 flex-col gap-0.5">
              <span class={schritt.ok ? 'text-text-muted' : 'text-text-bright font-medium'}>
                {text(schrittSchluessel(schritt.schritt))}
              </span>
              {#if erklaerung}
                <!-- Nur der ERSTE Fehlschlag bekommt die volle Erklärung. Bei
                     den folgenden stünde dieselbe Ursache noch dreimal da und
                     verstellte den Blick auf den Anfang der Kette. -->
                {#if i === ersterFehler}
                  <span class="text-text-muted leading-relaxed">{text(erklaerung)}</span>
                {/if}
              {/if}
              {#if schritt.einzelheit}
                <span class="text-text-muted font-mono text-[11px] break-all">
                  {schritt.einzelheit}
                </span>
              {/if}
            </div>
          </li>
        {/each}
      </ul>
    </div>
  {/if}
</div>
